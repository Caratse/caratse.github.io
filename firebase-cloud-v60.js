(() => {
  const SDK_VERSION = "12.16.0";
  const base = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

  function unavailable(reason) {
    const reject = async () => { throw new Error(reason); };
    return {
      configured: false,
      reason,
      persistence: "NONE",
      transport: "NONE",
      onAuth: () => () => {},
      signUp: reject,
      signIn: reject,
      resetPassword: reject,
      signOut: reject,
      subscribe: () => () => {},
      fetchServerState: reject,
      saveTransaction: reject,
      saveTransactionsBatch: reject,
      verifyTransaction: reject,
      verifyTransactionsBatch: reject,
      moveToTrash: reject,
      restoreFromTrash: reject,
      permanentlyDeleteTrash: reject,
      purgeExpiredTrash: reject,
      saveSettings: reject,
      replaceCategory: reject,
      importState: reject,
      clearCloudData: reject,
      testConnection: reject
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
    const transaction = plainTransaction(input);
    const deletedAtMs =
      Number(input.deletedAtMs) ||
      timestampMillis(input.deletedAt) ||
      Date.now();
    const expiresAtMs =
      Number(input.expiresAtMs) ||
      timestampMillis(input.expiresAt) ||
      deletedAtMs + TRASH_RETENTION_MS;

    return {
      ...transaction,
      deletedAtMs,
      expiresAtMs
    };
  }

  function settingsPayload(settings) {
    return {
      expenseCategories: Array.isArray(settings.expenseCategories)
        ? settings.expenseCategories
        : [],
      incomeCategories: Array.isArray(settings.incomeCategories)
        ? settings.incomeCategories
        : [],
      categoryIcons: settings.categoryIcons || {},
      budgets: settings.budgets || {},
      recurringExpenses: Array.isArray(settings.recurringExpenses)
        ? settings.recurringExpenses
        : [],
      reviewedDuplicateGroups: Array.isArray(settings.reviewedDuplicateGroups)
        ? settings.reviewedDuplicateGroups.map(String)
        : [],
      appearanceTheme: typeof settings.appearanceTheme === "string"
        ? settings.appearanceTheme
        : "warm"
    };
  }

  function encodeValue(value) {
    if (value === null || value === undefined) return { nullValue: null };
    if (value instanceof Date) return { timestampValue: value.toISOString() };

    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(encodeValue) } };
    }

    switch (typeof value) {
      case "boolean":
        return { booleanValue: value };
      case "number":
        if (!Number.isFinite(value)) return { nullValue: null };
        return Number.isInteger(value)
          ? { integerValue: String(value) }
          : { doubleValue: value };
      case "string":
        return { stringValue: value };
      case "object":
        return { mapValue: { fields: encodeFields(value) } };
      default:
        return { stringValue: String(value) };
    }
  }

  function encodeFields(object) {
    return Object.fromEntries(
      Object.entries(object || {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, encodeValue(value)])
    );
  }

  function decodeValue(value) {
    if (!value || typeof value !== "object") return null;
    if ("nullValue" in value) return null;
    if ("booleanValue" in value) return Boolean(value.booleanValue);
    if ("integerValue" in value) return Number(value.integerValue);
    if ("doubleValue" in value) return Number(value.doubleValue);
    if ("timestampValue" in value) return value.timestampValue;
    if ("stringValue" in value) return String(value.stringValue);
    if ("bytesValue" in value) return value.bytesValue;
    if ("referenceValue" in value) return value.referenceValue;
    if ("geoPointValue" in value) return value.geoPointValue;
    if ("arrayValue" in value) {
      return (value.arrayValue?.values || []).map(decodeValue);
    }
    if ("mapValue" in value) {
      return decodeFields(value.mapValue?.fields || {});
    }
    return null;
  }

  function decodeFields(fields) {
    return Object.fromEntries(
      Object.entries(fields || {}).map(([key, value]) => [key, decodeValue(value)])
    );
  }

  function documentId(document) {
    return decodeURIComponent(String(document.name || "").split("/").pop() || "");
  }

  function decodeDocument(document) {
    return {
      id: documentId(document),
      ...decodeFields(document.fields || {})
    };
  }

  window.CloudBudgetReady = (async () => {
    const config = window.DAILY_BUDGET_FIREBASE_CONFIG;
    if (!validConfig(config)) {
      return unavailable(
        "Firebase is not configured. Keep your existing firebase-config.js and verify its values."
      );
    }

    const [appModule, authModule] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`)
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
      sendPasswordResetEmail,
      getIdToken
    } = authModule;

    const app = initializeApp(config);
    const auth = initializeAuth(app, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence],
      popupRedirectResolver: undefined
    });

    const projectId = config.projectId;
    const databaseName = `projects/${projectId}/databases/(default)`;
    const documentsBase =
      `https://firestore.googleapis.com/v1/${databaseName}/documents`;
    const commitUrl =
      `https://firestore.googleapis.com/v1/${databaseName}/documents:commit`;
    const batchWriteUrl =
      `https://firestore.googleapis.com/v1/${databaseName}/documents:batchWrite`;
    const batchGetUrl =
      `https://firestore.googleapis.com/v1/${databaseName}/documents:batchGet`;

    function fullDocumentName(path) {
      return `${databaseName}/documents/${path}`;
    }

    function encodePathSegment(value) {
      return encodeURIComponent(String(value));
    }

    function userPath(uid, suffix = "") {
      return `users/${encodePathSegment(uid)}${suffix ? `/${suffix}` : ""}`;
    }

    async function authenticatedHeaders(forceRefresh = false) {
      const user = auth.currentUser;
      if (!user) {
        const error = new Error("Cloud request needs a signed-in account.");
        error.code = "unauthenticated";
        throw error;
      }

      const token = await getIdToken(user, forceRefresh);
      return {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      };
    }

    function readableRestError(status, payload, action) {
      const serverStatus =
        payload?.error?.status ||
        payload?.status ||
        "";
      const serverMessage =
        payload?.error?.message ||
        payload?.message ||
        "";

      let message;
      if (status === 401 || serverStatus === "UNAUTHENTICATED") {
        message =
          `${action} needs a fresh Firebase sign-in. Sign out, sign in again, then retry.`;
      } else if (status === 403 || serverStatus === "PERMISSION_DENIED") {
        message =
          `${action} reached Firestore, but the request was rejected by Security Rules. ` +
          `Do not import again until the Firestore rules are corrected.`;
      } else if (status === 404 || serverStatus === "NOT_FOUND") {
        message =
          `${action} reached Google, but the Firestore database or requested resource was not found. ` +
          `Check that the (default) Firestore database has been created in this Firebase project.`;
      } else if (status === 429 || serverStatus === "RESOURCE_EXHAUSTED") {
        message =
          `${action} was limited by Firebase quota. Wait several minutes before retrying.`;
      } else if (status >= 500 || serverStatus === "UNAVAILABLE") {
        message =
          `${action} reached Firestore, but the server was temporarily unavailable. Retry later.`;
      } else {
        message =
          `${action} failed with HTTP ${status}` +
          `${serverStatus ? ` / ${serverStatus}` : ""}` +
          `${serverMessage ? `: ${serverMessage}` : ""}`;
      }

      const error = new Error(message);
      error.code = serverStatus || `http-${status}`;
      error.httpStatus = status;
      error.serverMessage = serverMessage;
      return error;
    }

    async function restRequest(url, options = {}, action = "Cloud request") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 45000);

      try {
        const headers = await authenticatedHeaders(options.forceRefresh === true);
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: {
            ...headers,
            ...(options.headers || {})
          },
          body: options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
          cache: "no-store",
          signal: controller.signal
        });

        const text = await response.text();
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch (_) {
            payload = { message: text };
          }
        }

        if (!response.ok) {
          throw readableRestError(response.status, payload, action);
        }

        return payload || {};
      } catch (error) {
        if (
          error?.name === "AbortError" ||
          error instanceof TypeError ||
          /load failed|failed to fetch|network request failed/i.test(String(error?.message || ""))
        ) {
          const requestMethod = options.method || "GET";
          const wrapped = new Error(
            `${action} could not complete its ${requestMethod} request to Firestore. ` +
            `Reads may still work even when this request method is blocked by Safari, ` +
            `a VPN or a network proxy. Reopen the app and retry; if it still fails, ` +
            `switch networks or reconnect the VPN.`
          );
          wrapped.code = "rest-endpoint-unreachable";
          throw wrapped;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    function parseJsonSequence(text) {
      const source = String(text || "").trim();
      if (!source) return [];

      try {
        const parsed = JSON.parse(source);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch (_) {}

      const values = [];
      let start = -1;
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let index = 0; index < source.length; index++) {
        const char = source[index];

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === '"') {
            inString = false;
          }
          continue;
        }

        if (char === '"') {
          inString = true;
          continue;
        }

        if (char === "{" || char === "[") {
          if (depth === 0) start = index;
          depth++;
          continue;
        }

        if (char === "}" || char === "]") {
          depth--;
          if (depth === 0 && start >= 0) {
            const chunk = source.slice(start, index + 1);
            try {
              const parsed = JSON.parse(chunk);
              if (Array.isArray(parsed)) values.push(...parsed);
              else values.push(parsed);
            } catch (_) {}
            start = -1;
          }
        }
      }

      return values;
    }

    async function restStreamingRequest(
      url,
      options = {},
      action = "Cloud request"
    ) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs || 60000
      );

      try {
        const headers = await authenticatedHeaders(
          options.forceRefresh === true
        );
        const response = await fetch(url, {
          method: options.method || "POST",
          headers: {
            ...headers,
            ...(options.headers || {})
          },
          body: options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
          cache: "no-store",
          signal: controller.signal
        });

        const text = await response.text();
        if (!response.ok) {
          let payload = null;
          try { payload = JSON.parse(text); }
          catch (_) { payload = { message: text }; }
          throw readableRestError(response.status, payload, action);
        }

        return parseJsonSequence(text);
      } catch (error) {
        if (
          error?.name === "AbortError" ||
          error instanceof TypeError ||
          /load failed|failed to fetch|network request failed/i.test(
            String(error?.message || "")
          )
        ) {
          const wrapped = new Error(
            `${action} could not complete its POST request to Firestore. ` +
            `The App will keep the remaining records on this device and ` +
            `resume when it is active and the network is available.`
          );
          wrapped.code = "rest-endpoint-unreachable";
          throw wrapped;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function listCollection(uid, collectionName) {
      const documents = [];
      let pageToken = "";

      do {
        const query = new URLSearchParams({
          pageSize: "300",
          showMissing: "false"
        });
        if (pageToken) query.set("pageToken", pageToken);

        const url =
          `${documentsBase}/${userPath(uid, encodePathSegment(collectionName))}` +
          `?${query.toString()}`;

        const payload = await restRequest(
          url,
          {},
          `Read ${collectionName}`
        );

        documents.push(...(payload.documents || []).map(decodeDocument));
        pageToken = payload.nextPageToken || "";
      } while (pageToken);

      return documents;
    }

    async function getDocument(uid, path) {
      try {
        const payload = await restRequest(
          `${documentsBase}/${userPath(uid, path)}`,
          {},
          "Read cloud document"
        );
        return decodeDocument(payload);
      } catch (error) {
        if (error?.httpStatus === 404 || error?.code === "NOT_FOUND") return null;
        throw error;
      }
    }

    async function patchDocument(uid, path, data, action = "Save cloud document") {
      // Use the POST documents:commit endpoint instead of HTTP PATCH.
      // This keeps all writes on the most broadly compatible HTTPS method.
      await commitWrites(
        [updateWrite(uid, path, data)],
        action
      );

      const verified = await getDocument(uid, path);
      if (!verified) {
        throw new Error(`${action} verification failed: the document was not found.`);
      }
      return verified;
    }

    async function deleteDocument(uid, path, action = "Delete cloud document") {
      // Use POST commit instead of HTTP DELETE for the same compatibility reason.
      await commitWrites(
        [deleteWrite(uid, path)],
        action
      );
    }

    function updateWrite(uid, path, data) {
      return {
        update: {
          name: fullDocumentName(userPath(uid, path)),
          fields: encodeFields(data)
        }
      };
    }

    function deleteWrite(uid, path) {
      return {
        delete: fullDocumentName(userPath(uid, path))
      };
    }

    async function commitWrites(writes, action = "Save cloud changes") {
      if (!writes.length) return { writeResults: [], commitTime: "" };
      return await restRequest(
        commitUrl,
        {
          method: "POST",
          body: { writes },
          timeoutMs: 60000
        },
        action
      );
    }

    async function batchWrites(writes, action = "Import cloud records") {
      if (!writes.length) return;
      const payload = await restRequest(
        batchWriteUrl,
        {
          method: "POST",
          body: { writes },
          timeoutMs: 75000
        },
        action
      );

      const failures = (payload.status || []).filter(status =>
        status && Number(status.code || 0) !== 0
      );

      if (failures.length) {
        const first = failures[0];
        const error = new Error(
          `${action} partially failed: ${failures.length} write(s) were rejected. ` +
          `${first.message || ""}`.trim()
        );
        error.code = "partial-batch-failure";
        throw error;
      }
    }

    function historyId(action, transactionId) {
      return `${Date.now()}_${action}_${transactionId}`;
    }

    async function testConnection() {
      const start = Date.now();
      const user = auth.currentUser;
      if (!user) {
        throw new Error("Sign in before testing the cloud connection.");
      }

      // Use the real settings path already allowed by the app's Firestore rules.
      // If settings/app does not exist yet, getDocument returns null after a 404,
      // which still confirms that the REST endpoint, token and rules path work.
      await getDocument(user.uid, "settings/app");

      return {
        ok: true,
        transport: "REST_POST_COMMIT",
        elapsedMs: Date.now() - start,
        endpoint: "firestore.googleapis.com"
      };
    }

    async function purgeExpiredTrash(uid, nowMs = Date.now()) {
      const trash = await listCollection(uid, "trash");
      const writes = [];
      let purged = 0;
      let normalized = 0;

      trash.forEach(item => {
        const deletedAtMs =
          Number(item.deletedAtMs) ||
          timestampMillis(item.deletedAt) ||
          nowMs;
        const expiresAtMs =
          Number(item.expiresAtMs) ||
          timestampMillis(item.expiresAt) ||
          deletedAtMs + TRASH_RETENTION_MS;

        if (expiresAtMs <= nowMs) {
          writes.push(deleteWrite(uid, `trash/${encodePathSegment(item.id)}`));
          purged++;
        } else if (
          !Number(item.deletedAtMs) ||
          !Number(item.expiresAtMs) ||
          !item.expiresAt
        ) {
          writes.push(updateWrite(uid, `trash/${encodePathSegment(item.id)}`, {
            ...plainTrashTransaction(item),
            deletedAt: new Date(deletedAtMs),
            deletedAtMs,
            expiresAt: new Date(expiresAtMs),
            expiresAtMs
          }));
          normalized++;
        }
      });

      for (let start = 0; start < writes.length; start += 150) {
        await batchWrites(
          writes.slice(start, start + 150),
          "Maintain cloud trash"
        );
      }

      return {
        purged,
        normalized,
        retentionDays: TRASH_RETENTION_DAYS
      };
    }

    async function fetchServerState(uid) {
      const [transactions, settings, trash] = await Promise.all([
        listCollection(uid, "transactions"),
        getDocument(uid, "settings/app"),
        listCollection(uid, "trash")
      ]);

      return {
        transactions: transactions.map(plainTransaction),
        settings,
        trash: trash.map(plainTrashTransaction),
        trashMaintenance: {
          purged: 0,
          normalized: 0,
          retentionDays: TRASH_RETENTION_DAYS
        },
        transport: "REST_POST_COMMIT_QUOTA_SAFE"
      };
    }

    async function saveSettings(uid, settings) {
      return patchDocument(
        uid,
        "settings/app",
        {
          ...settingsPayload(settings),
          updatedAt: new Date()
        },
        "Save settings"
      );
    }

    async function saveTransaction(uid, transaction, previous = null) {
      const txn = plainTransaction(transaction);
      const now = new Date();

      await commitWrites([
        updateWrite(uid, `transactions/${encodePathSegment(txn.id)}`, {
          ...txn,
          updatedAt: now
        }),
        updateWrite(uid, `history/${encodePathSegment(historyId(
          previous ? "update" : "create",
          txn.id
        ))}`, {
          action: previous ? "update" : "create",
          transactionId: txn.id,
          before: previous ? plainTransaction(previous) : null,
          after: txn,
          at: now
        })
      ], previous ? "Update record" : "Create record");

      return txn;
    }

    async function saveTransactionsBatch(uid, entries = []) {
      const items = (Array.isArray(entries) ? entries : [])
        .map(entry => ({
          transaction: plainTransaction(entry?.transaction || entry),
          previous: entry?.previous ? plainTransaction(entry.previous) : null,
          updatedAtLocal:
            Number(entry?.transaction?.updatedAtLocal) ||
            Number(entry?.updatedAtLocal) ||
            Number(entry?.transaction?.createdAt) ||
            Number(entry?.createdAt) ||
            Date.now()
        }))
        .filter(item => item.transaction?.id);

      if (!items.length) {
        return { count: 0, transactions: [], commitTime: "" };
      }

      if (items.length > 50) {
        const error = new Error("Upload batch is limited to 50 records.");
        error.code = "batch-too-large";
        throw error;
      }

      const now = new Date();
      const writes = [];

      items.forEach(item => {
        const txn = item.transaction;
        const action = item.previous ? "update" : "create";
        const deterministicHistoryId =
          `sync_${action}_${txn.id}_${item.updatedAtLocal}`;

        writes.push(
          updateWrite(uid, `transactions/${encodePathSegment(txn.id)}`, {
            ...txn,
            updatedAt: now
          })
        );

        writes.push(
          updateWrite(
            uid,
            `history/${encodePathSegment(deterministicHistoryId)}`,
            {
              action,
              transactionId: txn.id,
              before: item.previous,
              after: txn,
              at: now,
              source: "batch-sync"
            }
          )
        );
      });

      const payload = await commitWrites(
        writes,
        `Upload ${items.length} record${items.length === 1 ? "" : "s"}`
      );

      return {
        count: items.length,
        transactions: items.map(item => item.transaction),
        commitTime: payload?.commitTime || "",
        writeResults: payload?.writeResults || []
      };
    }

    async function verifyTransaction(uid, id) {
      const verified = await getDocument(
        uid,
        `transactions/${encodePathSegment(id)}`
      );
      if (!verified) {
        throw new Error("Cloud verification failed: the record was not found.");
      }
      return plainTransaction(verified);
    }

    async function verifyTransactionsBatch(uid, ids = []) {
      const requested = [...new Set(
        (Array.isArray(ids) ? ids : [])
          .map(value => String(value || ""))
          .filter(Boolean)
      )];

      if (!requested.length) {
        return { records: {}, missing: [] };
      }

      if (requested.length > 100) {
        const error = new Error("Cloud verification batch is limited to 100 records.");
        error.code = "batch-too-large";
        throw error;
      }

      const documents = requested.map(id =>
        fullDocumentName(
          userPath(uid, `transactions/${encodePathSegment(id)}`)
        )
      );

      const responses = await restStreamingRequest(
        batchGetUrl,
        {
          method: "POST",
          body: { documents },
          timeoutMs: 75000
        },
        `Verify ${requested.length} record${requested.length === 1 ? "" : "s"}`
      );

      const records = {};
      const missing = new Set();

      responses.forEach(item => {
        if (item?.found) {
          const decoded = decodeDocument(item.found);
          records[String(decoded.id)] = plainTransaction(decoded);
        } else if (item?.missing) {
          const id = decodeURIComponent(
            String(item.missing).split("/").pop() || ""
          );
          if (id) missing.add(id);
        }
      });

      requested.forEach(id => {
        if (!records[id]) missing.add(id);
      });

      return {
        records,
        missing: [...missing]
      };
    }

    async function moveToTrash(uid, transaction) {
      const txn = plainTransaction(transaction);
      const deletedAtMs = Date.now();
      const expiresAtMs = deletedAtMs + TRASH_RETENTION_MS;
      const now = new Date();

      await commitWrites([
        updateWrite(uid, `trash/${encodePathSegment(txn.id)}`, {
          ...txn,
          deletedAt: now,
          deletedAtMs,
          expiresAt: new Date(expiresAtMs),
          expiresAtMs
        }),
        deleteWrite(uid, `transactions/${encodePathSegment(txn.id)}`),
        updateWrite(uid, `history/${encodePathSegment(historyId("delete", txn.id))}`, {
          action: "delete",
          transactionId: txn.id,
          before: txn,
          after: null,
          at: now
        })
      ], "Move record to trash");

      const [trashCheck, liveCheck] = await Promise.all([
        getDocument(uid, `trash/${encodePathSegment(txn.id)}`),
        getDocument(uid, `transactions/${encodePathSegment(txn.id)}`)
      ]);

      if (!trashCheck || liveCheck) {
        throw new Error("Cloud verification failed: the record was not safely moved.");
      }
      return plainTrashTransaction(trashCheck);
    }

    async function restoreFromTrash(uid, transaction) {
      const txn = plainTransaction(transaction);
      const now = new Date();

      await commitWrites([
        updateWrite(uid, `transactions/${encodePathSegment(txn.id)}`, {
          ...txn,
          updatedAt: now
        }),
        deleteWrite(uid, `trash/${encodePathSegment(txn.id)}`),
        updateWrite(uid, `history/${encodePathSegment(historyId("restore", txn.id))}`, {
          action: "restore",
          transactionId: txn.id,
          before: null,
          after: txn,
          at: now
        })
      ], "Restore record");

      const [liveCheck, trashCheck] = await Promise.all([
        getDocument(uid, `transactions/${encodePathSegment(txn.id)}`),
        getDocument(uid, `trash/${encodePathSegment(txn.id)}`)
      ]);

      if (!liveCheck || trashCheck) {
        throw new Error("Cloud verification failed: the record was not restored.");
      }
      return plainTransaction(liveCheck);
    }

    async function permanentlyDeleteTrash(uid, id) {
      await deleteDocument(
        uid,
        `trash/${encodePathSegment(id)}`,
        "Permanently delete trash item"
      );
      const check = await getDocument(uid, `trash/${encodePathSegment(id)}`);
      if (check) {
        throw new Error("Cloud verification failed: the trash item still exists.");
      }
    }

    async function replaceCategory(uid, type, oldName, newName, settings) {
      const transactions = await listCollection(uid, "transactions");
      const matches = transactions.filter(item =>
        item.type === type && item.category === oldName
      );

      const writes = matches.map(item =>
        updateWrite(uid, `transactions/${encodePathSegment(item.id)}`, {
          ...plainTransaction(item),
          category: newName,
          updatedAt: new Date()
        })
      );

      for (let start = 0; start < writes.length; start += 150) {
        await batchWrites(
          writes.slice(start, start + 150),
          "Update category records"
        );
      }

      await saveSettings(uid, settings);

      const verified = await listCollection(uid, "transactions");
      if (verified.some(item =>
        item.type === type && item.category === oldName
      )) {
        throw new Error("Cloud verification failed: old category records remain.");
      }
    }

    async function importState(uid, state) {
      const transactions = Array.isArray(state.transactions)
        ? state.transactions.map(plainTransaction)
        : [];
      const expectedIds = new Set(transactions.map(item => item.id));

      await patchDocument(
        uid,
        "settings/app",
        {
          ...settingsPayload(state),
          updatedAt: new Date(),
          lastImportExpectedCount: transactions.length,
          importTransport: "REST_POST_COMMIT"
        },
        "Save migration settings"
      );

      for (let start = 0; start < transactions.length; start += 150) {
        const chunk = transactions.slice(start, start + 150);
        await batchWrites(
          chunk.map(txn =>
            updateWrite(uid, `transactions/${encodePathSegment(txn.id)}`, {
              ...txn,
              importedAt: new Date(),
              updatedAt: new Date()
            })
          ),
          `Import records ${start + 1}-${start + chunk.length}`
        );
      }

      const verifiedState = await fetchServerState(uid);
      const serverIds = new Set(
        verifiedState.transactions.map(item => item.id)
      );
      const missing = [...expectedIds].filter(id => !serverIds.has(id));

      if (missing.length) {
        throw new Error(
          `Cloud verification failed: ${missing.length} imported record(s) are missing.`
        );
      }

      if (transactions.length && !verifiedState.transactions.length) {
        throw new Error("Cloud verification failed: the server returned zero records.");
      }

      return verifiedState;
    }

    async function clearCollection(uid, collectionName) {
      const documents = await listCollection(uid, collectionName);
      const writes = documents.map(item =>
        deleteWrite(uid, `${encodePathSegment(collectionName)}/${encodePathSegment(item.id)}`)
      );

      for (let start = 0; start < writes.length; start += 150) {
        await batchWrites(
          writes.slice(start, start + 150),
          `Clear ${collectionName}`
        );
      }
    }

    async function clearCloudData(uid) {
      await clearCollection(uid, "transactions");
      await clearCollection(uid, "trash");
      await clearCollection(uid, "history");

      try {
        await deleteDocument(uid, "settings/app", "Delete cloud settings");
      } catch (error) {
        if (error?.httpStatus !== 404 && error?.code !== "NOT_FOUND") throw error;
      }

      const verified = await fetchServerState(uid);
      if (
        verified.transactions.length ||
        verified.trash.length ||
        verified.settings
      ) {
        throw new Error("Cloud verification failed: some cloud data still exists.");
      }
    }

    function subscribe(uid, handlers) {
      let stopped = false;
      let timer = null;
      let running = false;

      const refresh = async () => {
        if (stopped || running || !navigator.onLine) return;
        running = true;
        try {
          const state = await fetchServerState(uid);
          if (stopped) return;

          const metadata = {
            fromCache: false,
            hasPendingWrites: false,
            transport: "REST"
          };

          handlers.onTransactions?.(state.transactions, metadata);
          handlers.onSettings?.(state.settings, metadata);
          handlers.onTrash?.(state.trash, metadata);
        } catch (error) {
          if (!stopped) handlers.onError?.(error);
        } finally {
          running = false;
        }
      };

      const onOnline = () => refresh();
      const onVisibility = () => {
        if (document.visibilityState === "visible") refresh();
      };

      window.addEventListener("online", onOnline);
      document.addEventListener("visibilitychange", onVisibility);
      refresh();
      timer = setInterval(refresh, 10 * 60 * 1000);

      return () => {
        stopped = true;
        clearInterval(timer);
        window.removeEventListener("online", onOnline);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }

    return {
      configured: true,
      projectId,
      persistence: "REST_POST_COMMIT",
      transport: "REST_POST_COMMIT",
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
      saveTransactionsBatch,
      verifyTransaction,
      verifyTransactionsBatch,
      moveToTrash,
      restoreFromTrash,
      permanentlyDeleteTrash,
      purgeExpiredTrash,
      saveSettings,
      replaceCategory,
      importState,
      clearCloudData,
      testConnection
    };
  })().catch(error => {
    console.error("Firebase REST initialization failed", error);
    return unavailable(
      error?.message || "Firebase REST initialization failed."
    );
  });
})();