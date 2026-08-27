// src/tests/pacer.test.js
// Unit tests for X-side pacing engine (rate limiting, queueing, and jitter).

"use strict";

const { createPacingQueue, PACING_DEFAULTS } = require("../../src/background/pacer");

describe("PacingEngine Queue & Rate Governor", () => {
  test("creates pacing queue with default configuration", () => {
    const pacer = createPacingQueue();
    expect(pacer.config.MIN_INTERVAL_MS).toBe(PACING_DEFAULTS.MIN_INTERVAL_MS);
    expect(pacer.config.MAX_ACTIONS_PER_WINDOW).toBe(PACING_DEFAULTS.MAX_ACTIONS_PER_WINDOW);
  });

  test("executes an action and returns its result asynchronously", async () => {
    const pacer = createPacingQueue({ MIN_INTERVAL_MS: 10, JITTER_MS: 5 });
    const action = jest.fn(() => "action_success");

    const result = await pacer.enqueue(action);
    expect(result).toBe("action_success");
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("queues multiple rapid actions sequentially without throwing errors", async () => {
    const pacer = createPacingQueue({ MIN_INTERVAL_MS: 20, JITTER_MS: 5 });
    const executionOrder = [];

    const promise1 = pacer.enqueue(() => { executionOrder.push(1); return "res1"; });
    const promise2 = pacer.enqueue(() => { executionOrder.push(2); return "res2"; });
    const promise3 = pacer.enqueue(() => { executionOrder.push(3); return "res3"; });

    const [r1, r2, r3] = await Promise.all([promise1, promise2, promise3]);
    expect(r1).toBe("res1");
    expect(r2).toBe("res2");
    expect(r3).toBe("res3");
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  test("provides telemetry stats on queue status", async () => {
    const pacer = createPacingQueue({ MIN_INTERVAL_MS: 50, JITTER_MS: 5 });
    await pacer.enqueue(() => "done");

    const stats = pacer.getStats();
    expect(stats.queueLength).toBe(0);
    expect(stats.isProcessing).toBe(false);
    expect(stats.actionsInCurrentWindow).toBe(1);
  });
});
