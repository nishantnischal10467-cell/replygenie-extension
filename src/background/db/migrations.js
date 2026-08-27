// src/background/db/migrations.js
// Reversible migrations engine for ReplyGenie IndexedDB.

/* eslint-disable no-var */

if (typeof STORES === "undefined" && typeof require !== "undefined") {
  var schema = require("./schema");
  var STORES = schema.STORES;
  var STORE_INDEXES = schema.STORE_INDEXES;
  var DB_VERSION = schema.DB_VERSION;
}

var MIGRATIONS = [
  {
    version: 1,
    description: "Initial schema: replies, voice_profiles, reply_patterns, generation_runs, retention_meta",
    up: function (db) {
      // 1. replies store
      if (!db.objectStoreNames.contains(STORES.REPLIES)) {
        var replyStore = db.createObjectStore(STORES.REPLIES, { keyPath: "id" });
        STORE_INDEXES[STORES.REPLIES].forEach(function (idx) {
          replyStore.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
        });
      }

      // 2. voice_profiles store
      if (!db.objectStoreNames.contains(STORES.VOICE_PROFILES)) {
        var voiceStore = db.createObjectStore(STORES.VOICE_PROFILES, { keyPath: "id" });
        STORE_INDEXES[STORES.VOICE_PROFILES].forEach(function (idx) {
          voiceStore.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
        });
      }

      // 3. reply_patterns store
      if (!db.objectStoreNames.contains(STORES.REPLY_PATTERNS)) {
        var patternStore = db.createObjectStore(STORES.REPLY_PATTERNS, { keyPath: "pattern_id" });
        STORE_INDEXES[STORES.REPLY_PATTERNS].forEach(function (idx) {
          patternStore.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
        });
      }

      // 4. generation_runs store
      if (!db.objectStoreNames.contains(STORES.GENERATION_RUNS)) {
        var runStore = db.createObjectStore(STORES.GENERATION_RUNS, { keyPath: "id" });
        STORE_INDEXES[STORES.GENERATION_RUNS].forEach(function (idx) {
          runStore.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
        });
      }

      // 5. retention_meta store
      if (!db.objectStoreNames.contains(STORES.RETENTION_META)) {
        var retentionStore = db.createObjectStore(STORES.RETENTION_META, { keyPath: "id", autoIncrement: true });
        STORE_INDEXES[STORES.RETENTION_META].forEach(function (idx) {
          retentionStore.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
        });
      }
    },
    down: function (db) {
      if (db.objectStoreNames.contains(STORES.REPLIES)) db.deleteObjectStore(STORES.REPLIES);
      if (db.objectStoreNames.contains(STORES.VOICE_PROFILES)) db.deleteObjectStore(STORES.VOICE_PROFILES);
      if (db.objectStoreNames.contains(STORES.REPLY_PATTERNS)) db.deleteObjectStore(STORES.REPLY_PATTERNS);
      if (db.objectStoreNames.contains(STORES.GENERATION_RUNS)) db.deleteObjectStore(STORES.GENERATION_RUNS);
      if (db.objectStoreNames.contains(STORES.RETENTION_META)) db.deleteObjectStore(STORES.RETENTION_META);
    },
  },
];

/**
 * Executes migrations on the database upgrade event.
 * @param {IDBDatabase} db
 * @param {number} oldVersion
 * @param {number} newVersion
 */
function runMigrations(db, oldVersion, newVersion) {
  if (oldVersion < newVersion) {
    // UP migrations
    MIGRATIONS.forEach(function (migration) {
      if (migration.version > oldVersion && migration.version <= newVersion) {
        migration.up(db);
      }
    });
  } else if (oldVersion > newVersion) {
    // DOWN migrations (rollback)
    var reversed = MIGRATIONS.slice().reverse();
    reversed.forEach(function (migration) {
      if (migration.version <= oldVersion && migration.version > newVersion) {
        migration.down(db);
      }
    });
  }
}

// Node.js / Jest exports
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MIGRATIONS,
    runMigrations,
  };
}
