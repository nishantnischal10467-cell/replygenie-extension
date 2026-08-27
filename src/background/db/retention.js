// src/background/db/retention.js
// Data retention policy engine and scheduled cleanup worker for ReplyGenie.

/* eslint-disable no-var */

if (typeof DB_NAME === "undefined" && typeof require !== "undefined") {
  var schema = require("./schema");
  var database = require("./database");
  var STORES = schema.STORES;
  var openDatabase = database.openDatabase;
  var resetDatabase = database.resetDatabase;
}

// ── Retention Policy Configuration ───────────────────────────────────────────

var RETENTION_CONFIG = {
  RAW_SOURCE_TEXT_TTL_DAYS:  90, // Purge raw tweet text after 90 days (preserves vectors/metrics)
  TRANSIENT_RUNS_TTL_DAYS:   30, // Purge failed/rejected generation runs after 30 days
  TRACE_LOGS_TTL_DAYS:       14, // Purge transient decision traces older than 14 days
};

var RETENTION_ALARM_NAME = "replygenie_retention_cleanup";

/**
 * Runs the data retention cleanup job across IndexedDB stores and local storage.
 * @returns {Promise<Object>} cleanup statistics
 */
async function runDataRetentionJob() {
  var db = await openDatabase();
  var now = Date.now();
  var DAY_MS = 24 * 60 * 60 * 1000;

  var sourceTextCutoff = new Date(now - RETENTION_CONFIG.RAW_SOURCE_TEXT_TTL_DAYS * DAY_MS).toISOString();
  var transientRunsCutoff = new Date(now - RETENTION_CONFIG.TRANSIENT_RUNS_TTL_DAYS * DAY_MS).toISOString();

  var stats = {
    executed_at: new Date().toISOString(),
    raw_texts_purged: 0,
    transient_runs_deleted: 0,
    trace_logs_pruned: 0,
  };

  // 1. Purge raw source tweet text older than 90 days from replies store
  var replyTx = db.transaction(STORES.REPLIES, "readwrite");
  var replyStore = replyTx.objectStore(STORES.REPLIES);
  var replyIndex = replyStore.index("created_at");

  await new Promise(function (resolve, reject) {
    var req = replyIndex.openCursor(IDBKeyRange.upperBound(sourceTextCutoff));
    req.onsuccess = function (e) {
      var cursor = e.target.result;
      if (cursor) {
        var reply = cursor.value;
        if (!reply.raw_text_purged && reply.source_tweet_text) {
          reply.source_tweet_text = "[PURGED_RETENTION_TTL]";
          reply.raw_text_purged = 1;
          reply.last_updated_at = new Date().toISOString();
          cursor.update(reply);
          stats.raw_texts_purged++;
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = function () { reject(req.error); };
  });

  // 2. Delete transient/failed generation runs older than 30 days
  var runTx = db.transaction(STORES.GENERATION_RUNS, "readwrite");
  var runStore = runTx.objectStore(STORES.GENERATION_RUNS);
  var runIndex = runStore.index("timestamp");

  await new Promise(function (resolve, reject) {
    var req = runIndex.openCursor(IDBKeyRange.upperBound(transientRunsCutoff));
    req.onsuccess = function (e) {
      var cursor = e.target.result;
      if (cursor) {
        var run = cursor.value;
        if (run.status === "error" || run.status === "rate_limited" || run.status === "rejected" || !run.generated_reply_id) {
          cursor.delete();
          stats.transient_runs_deleted++;
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = function () { reject(req.error); };
  });

  // 3. Record retention execution metadata
  var metaTx = db.transaction(STORES.RETENTION_META, "readwrite");
  var metaStore = metaTx.objectStore(STORES.RETENTION_META);
  await new Promise(function (resolve, reject) {
    var addReq = metaStore.add({
      job_type: "daily_retention_sweep",
      executed_at: stats.executed_at,
      stats: stats,
    });
    addReq.onsuccess = function () { resolve(); };
    addReq.onerror = function () { reject(addReq.error); };
  });

  // 4. Prune local decision trace log if chrome.storage is available
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    await new Promise(function (resolve) {
      chrome.storage.local.get({ decisionTraceLog: [] }, function (data) {
        var logs = Array.isArray(data.decisionTraceLog) ? data.decisionTraceLog : [];
        var traceCutoff = now - RETENTION_CONFIG.TRACE_LOGS_TTL_DAYS * DAY_MS;
        var filtered = logs.filter(function (entry) {
          var entryTs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
          return entryTs >= traceCutoff;
        });
        stats.trace_logs_pruned = logs.length - filtered.length;
        chrome.storage.local.set({ decisionTraceLog: filtered }, resolve);
      });
    });
  }

  return stats;
}

/**
 * GDPR Right to be Forgotten / Total User Data Reset.
 * Erases all database stores and resets chrome.storage profiles.
 * @returns {Promise<void>}
 */
async function purgeAllUserData() {
  await resetDatabase();
  if (typeof chrome !== "undefined" && chrome.storage) {
    await new Promise(function (resolve) {
      if (chrome.storage.local) chrome.storage.local.clear(resolve);
      else resolve();
    });
  }
}

/**
 * Initializes the periodic retention alarm in MV3 service worker.
 */
function initRetentionSchedule() {
  if (typeof chrome !== "undefined" && chrome.alarms) {
    chrome.alarms.get(RETENTION_ALARM_NAME, function (alarm) {
      if (!alarm) {
        chrome.alarms.create(RETENTION_ALARM_NAME, {
          periodInMinutes: 24 * 60, // Run once every 24 hours
        });
      }
    });

    chrome.alarms.onAlarm.addListener(function (alarm) {
      if (alarm.name === RETENTION_ALARM_NAME) {
        runDataRetentionJob().catch(function (err) {
          console.error("[ReplyGenie] Data retention sweep error:", err);
        });
      }
    });
  }
}

// Node.js / Jest exports
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RETENTION_CONFIG,
    RETENTION_ALARM_NAME,
    runDataRetentionJob,
    purgeAllUserData,
    initRetentionSchedule,
  };
}
