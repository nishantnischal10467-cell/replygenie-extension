// src/background/pacer.js
// X-side Pacing Engine: protects the user's X account from automated action flagging.
// Config-driven, graceful FIFO queue / delay execution.

/* eslint-disable no-var */

var PACING_DEFAULTS = {
  MIN_INTERVAL_MS:        10000, // 10 seconds minimum between actions
  JITTER_MS:              3000,  // 0-3000ms random jitter
  MAX_ACTIONS_PER_WINDOW: 15,    // Max 15 actions per 15-minute window
  WINDOW_MS:              15 * 60 * 1000,
  MAX_QUEUE_SIZE:         20,
};

var _PACING_CONFIG_KEY = "pacingConfig";

/**
 * Creates an instance of a PacingQueue.
 * @param {Object} [configOverrides]
 */
function createPacingQueue(configOverrides) {
  var config = Object.assign({}, PACING_DEFAULTS, configOverrides || {});
  var queue = [];
  var isProcessing = false;
  var actionHistory = []; // Timestamps of recent actions for window checks
  var lastActionTimestamp = 0;

  function _now() {
    return Date.now();
  }

  function _calculateDelay() {
    var now = _now();
    var timeSinceLast = now - lastActionTimestamp;
    var baseDelay = Math.max(0, config.MIN_INTERVAL_MS - timeSinceLast);
    var jitter = Math.floor(Math.random() * (config.JITTER_MS + 1));
    var delay = baseDelay + jitter;

    // Check sliding 15-minute window
    var cutoff = now - config.WINDOW_MS;
    actionHistory = actionHistory.filter(function (ts) { return ts >= cutoff; });

    if (actionHistory.length >= config.MAX_ACTIONS_PER_WINDOW) {
      var oldestInWindow = actionHistory[0];
      var windowResetDelay = (oldestInWindow + config.WINDOW_MS) - now;
      if (windowResetDelay > delay) {
        delay = windowResetDelay + jitter;
      }
    }

    return delay;
  }

  async function _processNext() {
    if (queue.length === 0) {
      isProcessing = false;
      return;
    }

    isProcessing = true;
    var item = queue.shift();
    var delay = _calculateDelay();

    if (delay > 0) {
      await new Promise(function (resolve) { setTimeout(resolve, delay); });
    }

    try {
      lastActionTimestamp = _now();
      actionHistory.push(lastActionTimestamp);
      var result = await Promise.resolve(item.actionFn());
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      _processNext();
    }
  }

  /**
   * Enqueues an action to be executed safely with rate pacing and jitter.
   * @param {Function} actionFn
   * @param {Object} [metadata]
   * @returns {Promise<any>}
   */
  function enqueue(actionFn, metadata) {
    if (queue.length >= config.MAX_QUEUE_SIZE) {
      return Promise.reject(new Error("Pacing queue is full (" + config.MAX_QUEUE_SIZE + " items). Please slow down."));
    }

    return new Promise(function (resolve, reject) {
      queue.push({
        actionFn: actionFn,
        metadata: metadata || {},
        enqueuedAt: _now(),
        resolve: resolve,
        reject: reject,
      });

      if (!isProcessing) {
        _processNext();
      }
    });
  }

  /**
   * Returns telemetry stats on queue health.
   */
  function getStats() {
    var now = _now();
    var cutoff = now - config.WINDOW_MS;
    var activeInWindow = actionHistory.filter(function (ts) { return ts >= cutoff; }).length;

    return {
      queueLength: queue.length,
      isProcessing: isProcessing,
      actionsInCurrentWindow: activeInWindow,
      maxActionsPerWindow: config.MAX_ACTIONS_PER_WINDOW,
      minIntervalMs: config.MIN_INTERVAL_MS,
      lastActionTimestamp: lastActionTimestamp,
      estimatedNextAvailableInMs: Math.max(0, config.MIN_INTERVAL_MS - (now - lastActionTimestamp)),
    };
  }

  /**
   * Clears the queue and resets state.
   */
  function reset() {
    queue.forEach(function (item) {
      item.reject(new Error("Pacing queue reset"));
    });
    queue = [];
    isProcessing = false;
    actionHistory = [];
    lastActionTimestamp = 0;
  }

  return {
    enqueue: enqueue,
    getStats: getStats,
    reset: reset,
    config: config,
  };
}

var globalPacer = createPacingQueue();

// Node.js / Jest exports
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PACING_DEFAULTS,
    createPacingQueue,
    globalPacer,
  };
}
