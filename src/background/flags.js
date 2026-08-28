// src/background/flags.js
// Feature flag infrastructure — ALL flags default to OFF.
// Override via chrome.storage.sync key "featureFlags": { "FLAG_NAME": true }.
// Never hardcode true here; use storage overrides for controlled rollout.

/* global chrome */
/* eslint-disable no-var */

var DEFAULT_FLAGS = {
  // Phase 1 safety rails — each off by default so existing behaviour is unchanged
  ENABLE_RATE_GOVERNOR:        false, // Rate/cost governor (API calls per hour/day)
  ENABLE_DECISION_LOGGING:     false, // Structured per-reply decision-trace logging
  ENABLE_PROMPT_ISOLATION:     false, // Untrusted-input isolation in LLM prompts

  // Phase 3+ — full pipeline (PostAnalyzer → embed → retrieve → rank → route → adapt/generate).
  // OFF by default. Enable ONLY after Phase 5 integration is verified end-to-end.
  ENABLE_INTELLIGENT_REPLY_ENGINE: false,
};

/**
 * Returns current feature flags merged with storage overrides.
 * Unknown override keys are ignored.
 * @returns {Promise<Object>}
 */
function getFlags() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get({ featureFlags: {} }, function (data) {
      var overrides = (data && typeof data.featureFlags === "object" && data.featureFlags !== null)
        ? data.featureFlags : {};
      var flags = Object.assign({}, DEFAULT_FLAGS);
      Object.keys(overrides).forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(DEFAULT_FLAGS, key)) {
          flags[key] = !!overrides[key];
        }
      });
      resolve(flags);
    });
  });
}

/**
 * Sets a single feature flag override in chrome.storage.sync.
 * @param {string}  flagName
 * @param {boolean} value
 * @returns {Promise<void>}
 */
function setFlag(flagName, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_FLAGS, flagName)) {
    return Promise.reject(new Error("Unknown flag: " + flagName));
  }
  return new Promise(function (resolve, reject) {
    chrome.storage.sync.get({ featureFlags: {} }, function (data) {
      var current = (data && data.featureFlags) ? data.featureFlags : {};
      var updated = Object.assign({}, current, { [flagName]: !!value });
      chrome.storage.sync.set({ updated }, function () {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  });
}

// Node.js / Jest compatibility
if (typeof module !== "undefined" && module.exports) {
  module.exports = { DEFAULT_FLAGS, getFlags, setFlag };
}
