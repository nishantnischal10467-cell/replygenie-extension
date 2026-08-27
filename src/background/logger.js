// src/background/logger.js
// Decision-trace logger — appends a structured record to chrome.storage.local
// for every reply produced (template or AI path).
//
// Storage: ring buffer in chrome.storage.local["decisionTraceLog"], max 100 entries.
// No external logging service — consistent with the no-backend architecture.
//
// Log schema (all fields):
// {
//   id:               string  — unique per record (timestamp + random suffix)
//   source_post_id:   string  — handle + first 40 chars of tweet (no full PII stored)
//   timestamp:        string  — ISO 8601 UTC
//   decision_path:    string  — "template:connect" | "template:thanks" | "template:congratulations"
//                              | "ai:gpt-4o-mini" | "ai:rate_limited" | "ai:no_api_key"
//   model_version:    string  — model used or "template" if short-circuit
//   outcome:          string  — "success" | "error" | "rate_limited" | "no_api_key"
//   latency_ms:       number  — ms from request receipt to response sent
//   injection_flagged:boolean — true if detectInjectionAttempt fired on this input
//   error_code:       string? — HTTP status or error type when outcome === "error"
// }

/* global chrome */
/* eslint-disable no-var */

var _TRACE_LOG_KEY = "decisionTraceLog";
var _TRACE_LOG_MAX = 100;

/**
 * Appends a structured trace record to the local ring buffer.
 * Fire-and-forget safe — callers should .catch(()=>{}).
 *
 * @param {Object} record — see schema above; id and timestamp are injected if absent
 * @returns {Promise<void>}
 */
function logTrace(record) {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ [_TRACE_LOG_KEY]: [] }, function (data) {
      var log = Array.isArray(data[_TRACE_LOG_KEY]) ? data[_TRACE_LOG_KEY] : [];

      var entry = Object.assign(
        {
          id:               Date.now() + "_" + Math.random().toString(36).slice(2, 7),
          timestamp:        new Date().toISOString(),
          injection_flagged: false,
        },
        record
      );

      log.push(entry);

      // Trim to ring buffer capacity
      if (log.length > _TRACE_LOG_MAX) {
        log = log.slice(log.length - _TRACE_LOG_MAX);
      }

      chrome.storage.local.set({ [_TRACE_LOG_KEY]: log }, resolve);
    });
  });
}

/**
 * Returns the full decision trace log (most recent last).
 * @returns {Promise<Array>}
 */
function getTraceLog() {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ [_TRACE_LOG_KEY]: [] }, function (data) {
      resolve(Array.isArray(data[_TRACE_LOG_KEY]) ? data[_TRACE_LOG_KEY] : []);
    });
  });
}

/**
 * Clears the trace log. Call only from an explicit "clear data" user action.
 * @returns {Promise<void>}
 */
function clearTraceLog() {
  return new Promise(function (resolve) {
    chrome.storage.local.set({ [_TRACE_LOG_KEY]: [] }, resolve);
  });
}

// Node.js / Jest compatibility
if (typeof module !== "undefined" && module.exports) {
  module.exports = { logTrace, getTraceLog, clearTraceLog, _TRACE_LOG_MAX };
}
