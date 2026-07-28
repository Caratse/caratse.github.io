(() => {
  const SDK_VERSION = "12.16.0";
  const base = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

  function unavailable(reason) {
    const reject = async () => { throw new Error(reason); };
    return {
      configured: false,
      reason,
      onAuth: () => () => {},
      signUp: reject,
      signIn: reject,
      resetPassword: reject,
      signOut: reject,
      subscribe: () => () => {},
      saveTransaction: reject,
      moveToTrash: reject,
      restoreFromTrash: reject,
      permanentlyDeleteTrash: reject,
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
      return unavailable("Firebase is not configured. Edit firebase-config.js first.");
    }

    const [
      appModule,
      authModule,
      firestoreModule
    ] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-firestore.js`)
    ]);

    const {
      initializeApp
    } = appModule;

    const {
      getAuth,
      onAuthStateChanged,
      createUserWithEmailAndPassword,
      signInWithEmailAndPassword,
      signOut,
      sendPasswordResetEmail,
      setPersistence,
      browserLocalPersistence
    } = authModule;

    const {
      getFirestore,
      collection,
      doc,
      setDoc,
      deleteDoc,
      getDocs,
      onSnapshot,
      writeBatch,
      serverTimestamp
    } = firestoreModule;

    const app = initializeApp(config);
    const auth = getAuth(app);
    const db = getFirestore(app);
    await setPersistence(auth, browserLocalPersistence);

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

    async function saveSettings(uid, settings) {
      await setDoc(settingsRef(uid), {
        expenseCategories: Array.isArray(settings.expenseCategories) ? settings.expenseCategories : [],
        incomeCategories: Array.isArray(settings.incomeCategories) ? settings.incomeCategories : [],
        categoryIcons: settings.categoryIcons || {},
        budgets: settings.budgets || {},
        updatedAt: serverTimestamp()
      }, { merge: true });
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

      await batch.commit();
    }

    async function moveToTrash(uid, transaction) {
      const txn = plainTransaction(transaction);
      const batch = writeBatch(db);
      batch.set(trashRef(uid, txn.id), {
        ...txn,
        deletedAt: serverTimestamp()
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
    }

    async function permanentlyDeleteTrash(uid, id) {
      await deleteDoc(trashRef(uid, id));
    }

    async function replaceCategory(uid, type, oldName, newName, settings) {
      const snapshot = await getDocs(collection(db, ...userRoot(uid), "transactions"));
      const matches = snapshot.docs
        .map(item => ({ id: item.id, ...item.data() }))
        .filter(item => item.type === type && item.category === oldName);

      if (!matches.length) {
        await saveSettings(uid, settings);
        return;
      }

      let settingsWritten = false;
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
            expenseCategories: settings.expenseCategories,
            incomeCategories: settings.incomeCategories,
            categoryIcons: settings.categoryIcons,
            budgets: settings.budgets,
            updatedAt: serverTimestamp()
          }, { merge: true });
          settingsWritten = true;
        }
        await batch.commit();
      }
    }

    async function importState(uid, state) {
      const transactions = Array.isArray(state.transactions)
        ? state.transactions.map(plainTransaction)
        : [];

      await saveSettings(uid, state);

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
    }

    async function clearCollection(uid, name) {
      const snapshot = await getDocs(collection(db, ...userRoot(uid), name));
      const docs = snapshot.docs;
      await chunkedBatches(
        docs,
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
    }

    function subscribe(uid, handlers) {
      const unsubs = [];

      unsubs.push(onSnapshot(
        collection(db, ...userRoot(uid), "transactions"),
        snapshot => handlers.onTransactions?.(
          snapshot.docs.map(item => plainTransaction({ id: item.id, ...item.data() }))
        ),
        error => handlers.onError?.(error)
      ));

      unsubs.push(onSnapshot(
        settingsRef(uid),
        snapshot => handlers.onSettings?.(snapshot.exists() ? snapshot.data() : null),
        error => handlers.onError?.(error)
      ));

      unsubs.push(onSnapshot(
        collection(db, ...userRoot(uid), "trash"),
        snapshot => handlers.onTrash?.(
          snapshot.docs.map(item => plainTransaction({ id: item.id, ...item.data() }))
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
      onAuth: callback => onAuthStateChanged(auth, callback),
      signUp: (email, password) => createUserWithEmailAndPassword(auth, email, password),
      signIn: (email, password) => signInWithEmailAndPassword(auth, email, password),
      resetPassword: email => sendPasswordResetEmail(auth, email),
      signOut: () => signOut(auth),
      subscribe,
      saveTransaction,
      moveToTrash,
      restoreFromTrash,
      permanentlyDeleteTrash,
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
