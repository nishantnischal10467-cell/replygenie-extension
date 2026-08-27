// src/background/governor.js
// Rate/cost governor — enforces per-hour and per-day caps on OpenAI API calls.
//
// Caps live in chrome.storage.local under key "governorConfig" so they can be
// changed without a code release (options page or DevTools console).
// Defaults are conservative; tune upward in production via storage override.
//
// Execution contract:
//   1. Call checkGovernor() BEFORE making an API call.
//   2. Call recordGovernorEvent() AFTER a successful API call.
//   3. If checkGovernor() returns {allowed:false}, throw its .reason string —
//      do NOT retry silently.

/* global chrome */
/* eslint-disable no-var */

// Default caps — named constants so a code reviewer can spot and change them.
// Override at runtime via chrome.storage.local key "governorConfig".
var GOVERNOR_DEFAULTS = {
  OPENAI_CALLS_PER_HOUR: 30,
  OPENAI_CALLS_PER_DAY:  200,
};

var _GOVERNOR_STATE_KEY  = "governorState";
var _GOVERNOR_CONFIG_KEY = "governorConfig";

/** Loads the operator-configurable cap values. */
function _getGovernorConfig() {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ [_GOVERNOR_CONFIG_KEY]: {} }, function (data) {
      resolve(Object.assign({}, GOVERNOR_DEFAULTS, data[_GOVERNOR_CONFIG_KEY] || {}));
    });
  });
}

/** Loads the persisted call-timestamp ring buffer. */
function _getGovernorState() {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ [_GOVERNOR_STATE_KEY]: { calls: [] } }, function (data) {
      resolve(data[_GOVERNOR_STATE_KEY] || { calls: [] });
    });
  });
}

/** Persists the call-timestamp ring buffer. */
function _saveGovernorState(state) {
  return new Promise(function (resolve) {
    chrome.storage.local.set({ [_GOVERNOR_STATE_KEY]: state }, resolve);
  });
}

/**
 * Checks whether an OpenAI API call is permitted under current caps.
 * Does NOT record the event — call recordGovernorEvent() after success.
 *
 * @returns {Promise<{allowed: boolean, reason: string|null}>}
 */
async function checkGovernor() {
  var config = await _getGovernorConfig();
  var state  = await _getGovernorState();
  var now    = Date.now();
  var HOUR   = 60 * 60 * 1000;
  var DAY    = 24 * HOUR;

  // Prune timestamps older than 24 h
  var calls = (state.calls || []).filter(function (ts) { return now - ts < DAY; });

  var callsLastHour = calls.filter(function (ts) { return now - ts < HOUR; }).length;
  var callsLastDay  = calls.length;

  if (callsLastHour >= config.OPENAI_CALLS_PER_HOUR) {
    return {
      allowed: false,
      reason:  "Rate limit: " + config.OPENAI_CALLS_PER_HOUR + " AI replies per hour reached. Wait a few minutes and try again.",
    };
  }
  if (callsLastDay >= config.OPENAI_CALLS_PER_DAY) {
    var oldestTs     = Math.min.apply(null, calls);
    var resetsInMs   = oldestTs + DAY - now;
    var resetsInHrs  = Math.max(1, Math.ceil(resetsInMs / HOUR));
    return {
      allowed: false,
      reason:  "Rate limit: " + config.OPENAI_CALLS_PER_DAY + " AI replies per day reached. Resets in ~" + resetsInHrs + "h.",
    };
  }

  return { allowed: true, reason: null };
}

/**
 * Records a successful OpenAI API call in the governor state.
 * Always call this after a successful call to keep counts accurate.
 */
async function recordGovernorEvent() {
  var state = await _getGovernorState();
  var now   = Date.now();
  var DAY   = 24 * 60 * 60 * 1000;

  var calls = (state.calls || []).filter(function (ts) { return now - ts < DAY; });
  calls.push(now);
  await _saveGovernorState({ calls: calls });
}

/**
 * Returns current usage statistics for display in options/popup.
 * @returns {Promise<{callsLastHour, callsLastDay, limitsPerHour, limitsPerDay}>}
 */
async function getGovernorStats() {
  var config = await _getGovernorConfig();
  var state  = await _getGovernorState();
  var now    = Date.now();
  var HOUR   = 60 * 60 * 1000;
  var DAY    = 24 * HOUR;

  var calls = (state.calls || []).filter(function (ts) { return now - ts < DAY; });
  return {
    callsLastHour: calls.filter(function (ts) { return now - ts < HOUR; }).length,
    callsLastDay:  calls.length,
    limitsPerHour: config.OPENAI_CALLS_PER_HOUR,
    limitsPerDay:  config.OPENAI_CALLS_PER_DAY,
  };
}

// Node.js / Jest compatibility
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    GOVERNOR_DEFAULTS,
    checkGovernor,
    recordGovernorEvent,
    getGovernorStats,
    // expose internals for testing (prefix with _ marks them as test-only)
    _getGovernorConfig,
    _getGovernorState,
    _saveGovernorState,
  };
}
