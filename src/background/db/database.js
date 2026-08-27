// src/background/db/database.js
// High-performance IndexedDB database layer for ReplyGenie.

/* eslint-disable no-var */

if (typeof DB_NAME === "undefined" && typeof require !== "undefined") {
  var schema = require("./schema");
  var migrations = require("./migrations");
  var DB_NAME = schema.DB_NAME;
  var DB_VERSION = schema.DB_VERSION;
  var STORES = schema.STORES;
  var createReplyRecord = schema.createReplyRecord;
  var createVoiceProfileRecord = schema.createVoiceProfileRecord;
  var createReplyPatternRecord = schema.createReplyPatternRecord;
  var createGenerationRunRecord = schema.createGenerationRunRecord;
  var runMigrations = migrations.runMigrations;
}

var _dbInstance = null;

/**
 * Opens or returns the cached IndexedDB database connection.
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
  if (_dbInstance) {
    return Promise.resolve(_dbInstance);
  }

  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = function (e) {
      var db = req.result;
      var oldVersion = e.oldVersion || 0;
      var newVersion = e.newVersion || DB_VERSION;
      runMigrations(db, oldVersion, newVersion);
    };

    req.onsuccess = function () {
      _dbInstance = req.result;
      _dbInstance.onversionchange = function () {
        _dbInstance.close();
        _dbInstance = null;
      };
      resolve(_dbInstance);
    };

    req.onerror = function () {
      reject(req.error || new Error("Failed to open database: " + DB_NAME));
    };

    req.onblocked = function () {
      console.warn("[ReplyGenieDB] Database upgrade blocked. Close other tabs running the extension.");
    };
  });
}

/**
 * Closes the active database connection.
 */
function closeDatabase() {
  if (_dbInstance) {
    _dbInstance.close();
    _dbInstance = null;
  }
}

// ── Generic IDB Promise Helpers ──────────────────────────────────────────────

function _idbReq(request) {
  return new Promise(function (resolve, reject) {
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

function _txDone(transaction) {
  return new Promise(function (resolve, reject) {
    transaction.oncomplete = function () { resolve(); };
    transaction.onerror = function () { reject(transaction.error); };
    transaction.onabort = function () { reject(transaction.error || new Error("Transaction aborted")); };
  });
}

// ── Replies Repository ───────────────────────────────────────────────────────

var repliesRepo = {
  /**
   * Inserts a new reply record.
   * @param {Object} partial
   * @returns {Promise<Object>}
   */
  insertReply: async function (partial) {
    var db = await openDatabase();
    var record = createReplyRecord(partial);
    var tx = db.transaction(STORES.REPLIES, "readwrite");
    var store = tx.objectStore(STORES.REPLIES);
    await _idbReq(store.add(record));
    await _txDone(tx);
    return record;
  },

  /**
   * Retrieves a reply by primary key ID.
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  getReplyById: async function (id) {
    var db = await openDatabase();
    var tx = db.transaction(STORES.REPLIES, "readonly");
    var store = tx.objectStore(STORES.REPLIES);
    var res = await _idbReq(store.get(id));
    return res || null;
  },

  /**
   * Updates an existing reply record.
   * @param {string} id
   * @param {Object} partialUpdates
   * @returns {Promise<Object>}
   */
  updateReply: async function (id, partialUpdates) {
    var db = await openDatabase();
    var tx = db.transaction(STORES.REPLIES, "readwrite");
    var store = tx.objectStore(STORES.REPLIES);
    var existing = await _idbReq(store.get(id));
    if (!existing) {
      throw new Error("Reply not found with id: " + id);
    }
    var updated = Object.assign({}, existing, partialUpdates, {
      last_updated_at: new Date().toISOString(),
    });
    await _idbReq(store.put(updated));
    await _txDone(tx);
    return updated;
  },

  /**
   * Deletes a reply record by ID.
   * @param {string} id
   * @returns {Promise<void>}
   */
  deleteReply: async function (id) {
    var db = await openDatabase();
    var tx = db.transaction(STORES.REPLIES, "readwrite");
    var store = tx.objectStore(STORES.REPLIES);
    await _idbReq(store.delete(id));
    await _txDone(tx);
  },

  /**
   * Queries replies by topic index.
   * @param {string} topic
   * @param {number} [limit=20]
   * @returns {Promise<Array>}
   */
  getRepliesByTopic: async function (topic, limit) {
    limit = limit || 20;
    var db = await openDatabase();
    var tx = db.transaction(STORES.REPLIES, "readonly");
    var store = tx.objectStore(STORES.REPLIES);
    var index = store.index("topic");
    return new Promise(function (resolve, reject) {
      var results = [];
      var req = index.openCursor(IDBKeyRange.only(topic), "prev");
      req.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = function () { reject(req.error); };
    });
  },

  /**
   * Queries replies by reply_strategy index.
   * @param {string} strategy
   * @param {number} [limit=20]
   * @returns {Promise<Array>}
   */
  getRepliesByStrategy: async function (strategy, limit) {
    limit = limit || 20;
    var db = await openDatabase();
    var tx = db.transaction(STORES.REPLIES, "readonly");
    var store = tx.objectStore(STORES.REPLIES);
    var index = store.index("reply_strategy");
    return new Promise(function (resolve, reject) {
      var results = [];
      var req = index.openCursor(IDBKeyRange.only(strategy), "prev");
      req.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = function () { reject(req.error); };
    });
  },

  /**
   * Gets recent replies ordered by created_at descending.
   * @param {number} [limit=20]
   * @returns {Promise<Array>}
   */
  getRecentReplies: async function (limit) {
    limit = limit || 20;
    var db = await openDatabase();
    var tx = db.transaction(STORES.REPLIES, "readonly");
    var store = tx.objectStore(STORES.REPLIES);
    var index = store.index("created_at");
    return new Promise(function (resolve, reject) {
      var results = [];
      var req = index.openCursor(null, "prev");
      req.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = function () { reject(req.error); };
    });
  },

  /**
   * Counts total replies in store.
   * @returns {Promise<number>}
   */
  countReplies: async function () {
    var db = await openDatabase();
    var tx = db.transaction(STORES.REPLIES, "readonly");
    var store = tx.objectStore(STORES.REPLIES);
    return await _idbReq(store.count());
  },
};

// ── Voice Profiles Repository ────────────────────────────────────────────────

var voiceProfilesRepo = {
  /**
   * Saves a new voice profile version. If is_active is true, deactivates older profiles.
   * @param {Object} partial
   * @returns {Promise<Object>}
   */
  saveVoiceProfile: async function (partial) {
    var db = await openDatabase();
    var record = createVoiceProfileRecord(partial);
    var tx = db.transaction(STORES.VOICE_PROFILES, "readwrite");
    var store = tx.objectStore(STORES.VOICE_PROFILES);

    if (record.is_active) {
      // Deactivate all existing profiles in transaction
      var cursorReq = store.openCursor();
      await new Promise(function (resolve, reject) {
        cursorReq.onsuccess = function (e) {
          var cursor = e.target.result;
          if (cursor) {
            if (cursor.value.is_active && cursor.value.id !== record.id) {
              var updateVal = Object.assign({}, cursor.value, { is_active: 0 });
              cursor.update(updateVal);
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = function () { reject(cursorReq.error); };
      });
    }

    await _idbReq(store.put(record));
    await _txDone(tx);
    return record;
  },

  /**
   * Returns the current active voice profile.
   * @returns {Promise<Object|null>}
   */
  getActiveVoiceProfile: async function () {
    var db = await openDatabase();
    var tx = db.transaction(STORES.VOICE_PROFILES, "readonly");
    var store = tx.objectStore(STORES.VOICE_PROFILES);
    var index = store.index("is_active");
    return new Promise(function (resolve, reject) {
      var req = index.openCursor(IDBKeyRange.only(1), "prev");
      req.onsuccess = function (e) {
        var cursor = e.target.result;
        resolve(cursor ? cursor.value : null);
      };
      req.onerror = function () { reject(req.error); };
    });
  },

  /**
   * Returns voice profile by version number.
   * @param {number} version
   * @returns {Promise<Object|null>}
   */
  getVoiceProfileByVersion: async function (version) {
    var db = await openDatabase();
    var tx = db.transaction(STORES.VOICE_PROFILES, "readonly");
    var store = tx.objectStore(STORES.VOICE_PROFILES);
    var index = store.index("version");
    var res = await _idbReq(index.get(version));
    return res || null;
  },

  /**
   * Returns all voice profiles ordered by version.
   * @returns {Promise<Array>}
   */
  getAllVoiceProfiles: async function () {
    var db = await openDatabase();
    var tx = db.transaction(STORES.VOICE_PROFILES, "readonly");
    var store = tx.objectStore(STORES.VOICE_PROFILES);
    var index = store.index("version");
    return await _idbReq(index.getAll());
  },
};

// ── Reply Patterns Repository ────────────────────────────────────────────────

var replyPatternsRepo = {
  /**
   * Saves or updates a reply pattern record.
   * @param {Object} partial
   * @returns {Promise<Object>}
   */
  saveReplyPattern: async function (partial) {
    var db = await openDatabase();
    var record = createReplyPatternRecord(partial);
    var tx = db.transaction(STORES.REPLY_PATTERNS, "readwrite");
    var store = tx.objectStore(STORES.REPLY_PATTERNS);
    await _idbReq(store.put(record));
    await _txDone(tx);
    return record;
  },

  /**
   * Queries patterns by strategy.
   * @param {string} strategy
   * @param {number} [limit=50]
   * @returns {Promise<Array>}
   */
  getPatternsByStrategy: async function (strategy, limit) {
    limit = limit || 50;
    var db = await openDatabase();
    var tx = db.transaction(STORES.REPLY_PATTERNS, "readonly");
    var store = tx.objectStore(STORES.REPLY_PATTERNS);
    var index = store.index("strategy");
    return new Promise(function (resolve, reject) {
      var results = [];
      var req = index.openCursor(IDBKeyRange.only(strategy), "prev");
      req.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = function () { reject(req.error); };
    });
  },

  /**
   * Queries patterns by topic.
   * @param {string} topic
   * @param {number} [limit=50]
   * @returns {Promise<Array>}
   */
  getPatternsByTopic: async function (topic, limit) {
    limit = limit || 50;
    var db = await openDatabase();
    var tx = db.transaction(STORES.REPLY_PATTERNS, "readonly");
    var store = tx.objectStore(STORES.REPLY_PATTERNS);
    var index = store.index("topic");
    return new Promise(function (resolve, reject) {
      var results = [];
      var req = index.openCursor(IDBKeyRange.only(topic), "prev");
      req.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = function () { reject(req.error); };
    });
  },

  /**
   * Returns all patterns for statistical analysis.
   * @returns {Promise<Array>}
   */
  getAllPatterns: async function () {
    var db = await openDatabase();
    var tx = db.transaction(STORES.REPLY_PATTERNS, "readonly");
    var store = tx.objectStore(STORES.REPLY_PATTERNS);
    return await _idbReq(store.getAll());
  },
};

// ── Generation Runs Repository ───────────────────────────────────────────────

var generationRunsRepo = {
  /**
   * Saves a generation run record.
   * @param {Object} partial
   * @returns {Promise<Object>}
   */
  saveGenerationRun: async function (partial) {
    var db = await openDatabase();
    var record = createGenerationRunRecord(partial);
    var tx = db.transaction(STORES.GENERATION_RUNS, "readwrite");
    var store = tx.objectStore(STORES.GENERATION_RUNS);
    await _idbReq(store.put(record));
    await _txDone(tx);
    return record;
  },

  /**
   * Gets generation runs by prompt_version for A/B testing evaluation.
   * @param {string} promptVersion
   * @param {number} [limit=50]
   * @returns {Promise<Array>}
   */
  getGenerationRunsByPromptVersion: async function (promptVersion, limit) {
    limit = limit || 50;
    var db = await openDatabase();
    var tx = db.transaction(STORES.GENERATION_RUNS, "readonly");
    var store = tx.objectStore(STORES.GENERATION_RUNS);
    var index = store.index("prompt_version");
    return new Promise(function (resolve, reject) {
      var results = [];
      var req = index.openCursor(IDBKeyRange.only(promptVersion), "prev");
      req.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = function () { reject(req.error); };
    });
  },

  /**
   * Gets recent generation runs.
   * @param {number} [limit=50]
   * @returns {Promise<Array>}
   */
  getRecentGenerationRuns: async function (limit) {
    limit = limit || 50;
    var db = await openDatabase();
    var tx = db.transaction(STORES.GENERATION_RUNS, "readonly");
    var store = tx.objectStore(STORES.GENERATION_RUNS);
    var index = store.index("timestamp");
    return new Promise(function (resolve, reject) {
      var results = [];
      var req = index.openCursor(null, "prev");
      req.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = function () { reject(req.error); };
    });
  },
};

/**
 * Resets / deletes the entire database (used for testing or GDPR purge).
 * @returns {Promise<void>}
 */
function resetDatabase() {
  closeDatabase();
  return new Promise(function (resolve, reject) {
    var req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = function () { resolve(); };
    req.onerror = function () { reject(req.error); };
  });
}

// Node.js / Jest exports
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    openDatabase,
    closeDatabase,
    resetDatabase,
    repliesRepo,
    voiceProfilesRepo,
    replyPatternsRepo,
    generationRunsRepo,
  };
}
