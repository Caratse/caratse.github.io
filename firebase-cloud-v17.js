(() => {
  const SDK_VERSION = "12.16.0";
  const base = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

  function unavailable(reason) {
    const reject = async () => { throw new Error(reason); };
    return {
      configured: false,
      reason,
      persistence: "NONE",
      onAuth: () => () => {},
      signUp: reject,
      signIn: reject,
      resetPassword: reject,
      signOut: reject,
      subscribe: () => () => {},
      fetchServerState: reject,
      saveTransaction: reject,
      verifyTransaction: reject,
      moveToTrash: reject,
      restoreFromTrash: reject,
      permanentlyDeleteTrash: reject,
      purgeExpiredTrash: reject,
      saveSettings: reject,
      replaceCategory: reject,
      importState: reject,
      clearCloudData: reject
    };
  }

  function validConfig(config) {
    return config &&
      typeof config.apiKey === "string" &&
      config.apiKey &&
      !config.apiKey.includes("PASTE_") &&
      typeof config.projectId === "string" &&
      config.projectId &&
      !config.projectId.includes("PASTE_") &&
      typeof config.appId === "string" &&
      config.appId &&
      !config.appId.includes("PASTE_");
  }

  function plainTransaction(input) {
    return {
      id: String(input.id),
      type: input.type === "income" ? "income" : "expense",
      amount: Number(input.amount) || 0,
      date: String(input.date || ""),
      category: String(input.category || "Other"),
      tag: String(input.tag || ""),
      createdAt: Number(input.createdAt) || Date.now()
    };
  }

  const TRASH_RETENTION_DAYS = 30;
  const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  function timestampMillis(value) {
    if (!value) return 0;
    if (typeof value === "number") return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.seconds === "number") {
      return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function plainTrashTransaction(input) {
    const baseTransaction = plainTransaction(input);
    const deletedAtMs =
      Number(input.deletedAtMs) ||
      timestampMillis(input.deletedAt) ||
      Date.now();
    const expiresAtMs =
      Number(input.expiresAtMs) ||
      timestampMillis(input.expiresAt) ||
      deletedAtMs + TRASH_RETENTION_MS;

    return {
      ...baseTransaction,
      deletedAtMs,
      expiresAtMs
    };
  }

  function settingsPayload(settings) {
    return {
      expenseCategories: Array.isArray(settings.expenseCategories) ? settings.expenseCategories : [],
      incomeCategories: Array.isArray(settings.incomeCategories) ? settings.incomeCategories : [],
      categoryIcons: settings.categoryIcons || {},
      budgets: settings.budgets || {}
    };
  }

  async function chunkedBatches(items, makeWrites, writeBatch, db, size = 300) {
    for (let start = 0; start < items.length; start += size) {
      const batch = writeBatch(db);
      items.slice(start, start + size).forEach(item => makeWrites(batch, item));
      await batch.commit();
    }
  }

  window.CloudBudgetReady = (async () => {
    const config = window.DAILY_BUDGET_FIREBASE_CONFIG;
    if (!validConfig(config)) {
      return unavailable("Firebase is not configured. Keep your existing firebase-config.js and verify its values.");
    }

    const [appModule, authModule, firestoreModule] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-firestore.js`)
    ]);

    const { initializeApp } = appModule;

    const {
      initializeAuth,
      indexedDBLocalPersistence,
      browserLocalPersistence,
      onAuthStateChanged,
      createUserWithEmailAndPassword,
      signInWithEmailAndPassword,
      signOut,
      sendPasswordResetEmail
    } = authModule;

    const {
      initializeFirestore,
      memoryLocalCache,
      collection,
      doc,
      setDoc,
      deleteDoc,
      getDocs,
      getDocsFromServer,
      getDocFromServer,
      onSnapshot,
      writeBatch,
      serverTimestamp,
      Timestamp,
      waitForPendingWrites
    } = firestoreModule;

    const app = initializeApp(config);

    // Use durable device storage first. Firebase automatically falls back to
    // localStorage when IndexedDB is unavailable.
    const auth = initializeAuth(app, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence],
      popupRedirectResolver: undefined
    });

    // Firestore memory cache prevents old browser cache from being treated as
    // server-confirmed data. Every successful write below is explicitly
    // acknowledged and then verified against the server.
    const db = initializeFirestore(app, {
      localCache: memoryLocalCache()
    });

    function userRoot(uid) {
      return ["users", uid];
    }

    function transactionRef(uid, id) {
      return doc(db, ...userRoot(uid), "transactions", id);
    }

    function trashRef(uid, id) {
      return doc(db, ...userRoot(uid), "trash", id);
    }

    function historyRef(uid, id) {
      return doc(db, ...userRoot(uid), "history", id);
    }

    function settingsRef(uid) {
      return doc(db, ...userRoot(uid), "settings", "app");
    }

    function historyId(action, transactionId) {
      return `${Date.now()}_${action}_${transactionId}`;
    }

    async function waitForServer() {
      await waitForPendingWrites(db);
    }

    async function fetchServerState(uid) {
      const trashMaintenance = await purgeExpiredTrash(uid);
      const [transactionSnapshot, settingsSnapshot, trashSnapshot] = await Promise.all([
        getDocsFromServer(collection(db, ...userRoot(uid), "transactions")),
        getDocFromServer(settingsRef(uid)),
        getDocsFromServer(collection(db, ...userRoot(uid), "trash"))
      ]);

      return {
        transactions: transactionSnapshot.docs.map(item =>
          plainTransaction({ id: item.id, ...item.data() })
        ),
        settings: settingsSnapshot.exists() ? settingsSnapshot.data() : null,
        trash: trashSnapshot.docs.map(item =>
          plainTrashTransaction({ id: item.id, ...item.data() })
        ),
        trashMaintenance
      };
    }

    async function saveSettings(uid, settings) {
      const payload = settingsPayload(settings);
      await setDoc(settingsRef(uid), {
        ...payload,
        updatedAt: serverTimestamp()
      }, { merge: true });

      await waitForServer();
      const verified = await getDocFromServer(settingsRef(uid));
      if (!verified.exists()) {
        throw new Error("Cloud verification failed: settings were not found on the server.");
      }
      return verified.data();
    }

    async function saveTransaction(uid, transaction, previous = null) {
      const txn = plainTransaction(transaction);
      const batch = writeBatch(db);

      batch.set(transactionRef(uid, txn.id), {
        ...txn,
        updatedAt: serverTimestamp()
      });

      batch.set(historyRef(uid, historyId(previous ? "update" : "create", txn.id)), {
        action: previous ? "update" : "create",
        transactionId: txn.id,
        before: previous ? plainTransaction(previous) : null,
        after: txn,
        at: serverTimestamp()
      });

      // Firestore batch.commit() resolves after the backend accepts the write.
      // V17 does not add another blocking server read before returning.
      await batch.commit();
      return txn;
    }

    async function verifyTransaction(uid, id) {
      const verified = await getDocFromServer(transactionRef(uid, id));
      if (!verified.exists()) {
        throw new Error("Cloud verification failed: the record was not found on the server.");
      }
      return plainTransaction({ id: verified.id, ...verified.data() });
    }

    async function moveToTrash(uid, transaction) {
      const txn = plainTransaction(transaction);
      const batch = writeBatch(db);
      const deletedAtMs = Date.now();
      const expiresAtMs = deletedAtMs + TRASH_RETENTION_MS;

      batch.set(trashRef(uid, txn.id), {
        ...txn,
        deletedAt: serverTimestamp(),
        deletedAtMs,
        expiresAt: Timestamp.fromMillis(expiresAtMs),
        expiresAtMs
      });
      batch.delete(transactionRef(uid, txn.id));
      batch.set(historyRef(uid, historyId("delete", txn.id)), {
        action: "delete",
        transactionId: txn.id,
        before: txn,
        after: null,
        at: serverTimestamp()
      });

      await batch.commit();
      await waitForServer();

      const [trashCheck, liveCheck] = await Promise.all([
        getDocFromServer(trashRef(uid, txn.id)),
        getDocFromServer(transactionRef(uid, txn.id))
      ]);
      if (!trashCheck.exists() || liveCheck.exists()) {
        throw new Error("Cloud verification failed: the record was not safely moved to trash.");
      }
      return plainTrashTransaction({ id: trashCheck.id, ...trashCheck.data() });
    }

    async function restoreFromTrash(uid, transaction) {
      const txn = plainTransaction(transaction);
      const batch = writeBatch(db);

      batch.set(transactionRef(uid, txn.id), {
        ...txn,
        updatedAt: serverTimestamp()
      });
      batch.delete(trashRef(uid, txn.id));
      batch.set(historyRef(uid, historyId("restore", txn.id)), {
        action: "restore",
        transactionId: txn.id,
        before: null,
        after: txn,
        at: serverTimestamp()
      });

      await batch.commit();
      await waitForServer();

      const [liveCheck, trashCheck] = await Promise.all([
        getDocFromServer(transactionRef(uid, txn.id)),
        getDocFromServer(trashRef(uid, txn.id))
      ]);
      if (!liveCheck.exists() || trashCheck.exists()) {
        throw new Error("Cloud verification failed: the record was not restored.");
      }
      return plainTransaction({ id: liveCheck.id, ...liveCheck.data() });
    }

    async function permanentlyDeleteTrash(uid, id) {
      await deleteDoc(trashRef(uid, id));
      await waitForServer();
      const check = await getDocFromServer(trashRef(uid, id));
      if (check.exists()) {
        throw new Error("Cloud verification failed: the trash item still exists.");
      }
    }

    async function replaceCategory(uid, type, oldName, newName, settings) {
      const snapshot = await getDocsFromServer(
        collection(db, ...userRoot(uid), "transactions")
      );
      const matches = snapshot.docs
        .map(item => ({ id: item.id, ...item.data() }))
        .filter(item => item.type === type && item.category === oldName);

      let settingsWritten = false;
      if (!matches.length) {
        await saveSettings(uid, settings);
        return;
      }

      for (let start = 0; start < matches.length; start += 300) {
        const batch = writeBatch(db);
        matches.slice(start, start + 300).forEach(item => {
          batch.set(transactionRef(uid, item.id), {
            category: newName,
            updatedAt: serverTimestamp()
          }, { merge: true });
        });

        if (!settingsWritten) {
          batch.set(settingsRef(uid), {
            ...settingsPayload(settings),
            updatedAt: serverTimestamp()
          }, { merge: true });
          settingsWritten = true;
        }
        await batch.commit();
      }

      await waitForServer();
      const verified = await getDocsFromServer(
        collection(db, ...userRoot(uid), "transactions")
      );
      const remainingOld = verified.docs.some(item => {
        const data = item.data();
        return data.type === type && data.category === oldName;
      });
      if (remainingOld) {
        throw new Error("Cloud verification failed: some records still use the old category.");
      }
    }

    async function importState(uid, state) {
      const transactions = Array.isArray(state.transactions)
        ? state.transactions.map(plainTransaction)
        : [];
      const expectedIds = new Set(transactions.map(item => item.id));

      await setDoc(settingsRef(uid), {
        ...settingsPayload(state),
        updatedAt: serverTimestamp(),
        lastImportExpectedCount: transactions.length
      }, { merge: true });

      await chunkedBatches(
        transactions,
        (batch, txn) => {
          batch.set(transactionRef(uid, txn.id), {
            ...txn,
            importedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        },
        writeBatch,
        db
      );

      await waitForServer();

      const verifiedState = await fetchServerState(uid);
      const serverIds = new Set(verifiedState.transactions.map(item => item.id));
      const missing = [...expectedIds].filter(id => !serverIds.has(id));

      if (missing.length) {
        throw new Error(
          `Cloud verification failed: ${missing.length} imported record(s) are missing on the server.`
        );
      }

      if (transactions.length > 0 && verifiedState.transactions.length === 0) {
        throw new Error("Cloud verification failed: the server returned zero records.");
      }

      return verifiedState;
    }

    async function purgeExpiredTrash(uid, nowMs = Date.now()) {
      const snapshot = await getDocsFromServer(
        collection(db, ...userRoot(uid), "trash")
      );

      const actions = snapshot.docs.map(item => {
        const data = item.data();
        const deletedAtMs =
          Number(data.deletedAtMs) ||
          timestampMillis(data.deletedAt) ||
          nowMs;
        const expiresAtMs =
          Number(data.expiresAtMs) ||
          timestampMillis(data.expiresAt) ||
          deletedAtMs + TRASH_RETENTION_MS;

        return {
          ref: item.ref,
          shouldDelete: expiresAtMs <= nowMs,
          needsExpiry:
            !Number(data.deletedAtMs) ||
            !Number(data.expiresAtMs) ||
            !data.expiresAt,
          deletedAtMs,
          expiresAtMs
        };
      });

      let purged = 0;
      let normalized = 0;

      for (let start = 0; start < actions.length; start += 300) {
        const chunk = actions.slice(start, start + 300);
        const batch = writeBatch(db);
        let writes = 0;

        chunk.forEach(action => {
          if (action.shouldDelete) {
            batch.delete(action.ref);
            purged++;
            writes++;
          } else if (action.needsExpiry) {
            batch.set(action.ref, {
              deletedAtMs: action.deletedAtMs,
              expiresAtMs: action.expiresAtMs,
              expiresAt: Timestamp.fromMillis(action.expiresAtMs)
            }, { merge: true });
            normalized++;
            writes++;
          }
        });

        if (writes) await batch.commit();
      }

      if (purged || normalized) await waitForServer();

      return {
        purged,
        normalized,
        retentionDays: TRASH_RETENTION_DAYS
      };
    }

    async function clearCollection(uid, name) {
      const snapshot = await getDocsFromServer(
        collection(db, ...userRoot(uid), name)
      );
      await chunkedBatches(
        snapshot.docs,
        (batch, item) => batch.delete(item.ref),
        writeBatch,
        db
      );
    }

    async function clearCloudData(uid) {
      await clearCollection(uid, "transactions");
      await clearCollection(uid, "trash");
      await clearCollection(uid, "history");
      await deleteDoc(settingsRef(uid));
      await waitForServer();

      const verified = await fetchServerState(uid);
      if (verified.transactions.length || verified.trash.length || verified.settings) {
        throw new Error("Cloud verification failed: some cloud data still exists.");
      }
    }

    function subscribe(uid, handlers) {
      const unsubs = [];

      unsubs.push(onSnapshot(
        collection(db, ...userRoot(uid), "transactions"),
        { includeMetadataChanges: true },
        snapshot => handlers.onTransactions?.(
          snapshot.docs.map(item =>
            plainTransaction({ id: item.id, ...item.data() })
          ),
          {
            fromCache: snapshot.metadata.fromCache,
            hasPendingWrites: snapshot.metadata.hasPendingWrites
          }
        ),
        error => handlers.onError?.(error)
      ));

      unsubs.push(onSnapshot(
        settingsRef(uid),
        { includeMetadataChanges: true },
        snapshot => handlers.onSettings?.(
          snapshot.exists() ? snapshot.data() : null,
          {
            fromCache: snapshot.metadata.fromCache,
            hasPendingWrites: snapshot.metadata.hasPendingWrites
          }
        ),
        error => handlers.onError?.(error)
      ));

      unsubs.push(onSnapshot(
        collection(db, ...userRoot(uid), "trash"),
        { includeMetadataChanges: true },
        snapshot => handlers.onTrash?.(
          snapshot.docs.map(item =>
            plainTrashTransaction({ id: item.id, ...item.data() })
          ),
          {
            fromCache: snapshot.metadata.fromCache,
            hasPendingWrites: snapshot.metadata.hasPendingWrites
          }
        ),
        error => handlers.onError?.(error)
      ));

      return () => unsubs.forEach(unsub => {
        try { unsub(); } catch (_) {}
      });
    }

    return {
      configured: true,
      projectId: config.projectId,
      persistence: "LOCAL",
      onAuth: callback => {
        let unsubscribe = null;
        let cancelled = false;
        auth.authStateReady()
          .then(() => {
            if (!cancelled) unsubscribe = onAuthStateChanged(auth, callback);
          })
          .catch(error => {
            console.error("Auth state restore failed", error);
            if (!cancelled) callback(null);
          });
        return () => {
          cancelled = true;
          try { unsubscribe?.(); } catch (_) {}
        };
      },
      signUp: (email, password) =>
        createUserWithEmailAndPassword(auth, email, password),
      signIn: (email, password) =>
        signInWithEmailAndPassword(auth, email, password),
      resetPassword: email =>
        sendPasswordResetEmail(auth, email),
      signOut: () =>
        signOut(auth),
      subscribe,
      fetchServerState,
      saveTransaction,
      verifyTransaction,
      moveToTrash,
      restoreFromTrash,
      permanentlyDeleteTrash,
      purgeExpiredTrash,
      saveSettings,
      replaceCategory,
      importState,
      clearCloudData
    };
  })().catch(error => {
    console.error("Firebase initialization failed", error);
    return unavailable(error?.message || "Firebase initialization failed.");
  });
})();
