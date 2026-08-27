// src/tests/governor.test.js
// Unit tests for src/background/governor.js.
// chrome.storage is stubbed in src/tests/setup.js.

"use strict";

const {
  GOVERNOR_DEFAULTS,
  checkGovernor,
  recordGovernorEvent,
  getGovernorStats,
} = require("../../src/background/governor");

// Helper — reset chrome.storage.local mock state before each test
function resetStorage(calls = [], config = {}) {
  const store = {
    governorState:  { calls },
    governorConfig: config,
  };
  chrome.storage.local.get.mockImplementation((defaults, cb) => {
    const key = Object.keys(defaults)[0];
    cb({ [key]: store[key] !== undefined ? store[key] : defaults[key] });
  });
  chrome.storage.local.set.mockImplementation((data, cb) => {
    Object.assign(store, data);
    if (cb) cb();
  });
  return store;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Default caps ──────────────────────────────────────────────────────────────

describe("GOVERNOR_DEFAULTS", () => {
  test("has OPENAI_CALLS_PER_HOUR", () => {
    expect(GOVERNOR_DEFAULTS.OPENAI_CALLS_PER_HOUR).toBeGreaterThan(0);
  });
  test("has OPENAI_CALLS_PER_DAY", () => {
    expect(GOVERNOR_DEFAULTS.OPENAI_CALLS_PER_DAY).toBeGreaterThan(0);
  });
  test("per-hour cap is less than per-day cap", () => {
    expect(GOVERNOR_DEFAULTS.OPENAI_CALLS_PER_HOUR).toBeLessThan(GOVERNOR_DEFAULTS.OPENAI_CALLS_PER_DAY);
  });
});

// ── checkGovernor — allowed paths ─────────────────────────────────────────────

describe("checkGovernor — allowed", () => {
  test("allows call when no history", async () => {
    resetStorage([]);
    const result = await checkGovernor();
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });

  test("allows call when under both caps", async () => {
    const now = Date.now();
    // 5 calls in last hour, well under default 30
    resetStorage(Array(5).fill(now - 1000));
    const result = await checkGovernor();
    expect(result.allowed).toBe(true);
  });
});

// ── checkGovernor — rate-limited paths ────────────────────────────────────────

describe("checkGovernor — rate-limited", () => {
  test("blocks when hourly cap is reached", async () => {
    const now = Date.now();
    // Fill exactly OPENAI_CALLS_PER_HOUR calls within the last hour
    const calls = Array(GOVERNOR_DEFAULTS.OPENAI_CALLS_PER_HOUR).fill(now - 1000);
    resetStorage(calls, {});
    const result = await checkGovernor();
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/per hour/i);
  });

  test("blocks when daily cap is reached", async () => {
    const now = Date.now();
    // Put all calls outside the 1h window but inside 24h
    const calls = Array(GOVERNOR_DEFAULTS.OPENAI_CALLS_PER_DAY).fill(now - 2 * 60 * 60 * 1000);
    resetStorage(calls, {});
    const result = await checkGovernor();
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/per day/i);
  });

  test("prunes calls older than 24h (stale calls do not block)", async () => {
    const now = Date.now();
    const DAY  = 24 * 60 * 60 * 1000;
    // All calls are > 24h old — should be pruned
    const calls = Array(GOVERNOR_DEFAULTS.OPENAI_CALLS_PER_DAY + 10).fill(now - DAY - 1000);
    resetStorage(calls, {});
    const result = await checkGovernor();
    expect(result.allowed).toBe(true);
  });

  test("respects custom config overrides", async () => {
    resetStorage([Date.now() - 1000], { OPENAI_CALLS_PER_HOUR: 1 });
    const result = await checkGovernor();
    expect(result.allowed).toBe(false);
  });
});

// ── recordGovernorEvent ────────────────────────────────────────────────────────

describe("recordGovernorEvent", () => {
  test("adds a timestamp to the call list", async () => {
    const store = resetStorage([]);
    await recordGovernorEvent();
    expect(store.governorState.calls.length).toBe(1);
    expect(store.governorState.calls[0]).toBeGreaterThan(0);
  });

  test("accumulates multiple events", async () => {
    const store = resetStorage([]);
    await recordGovernorEvent();
    await recordGovernorEvent();
    expect(store.governorState.calls.length).toBe(2);
  });
});

// ── getGovernorStats ──────────────────────────────────────────────────────────

describe("getGovernorStats", () => {
  test("returns callsLastHour and callsLastDay", async () => {
    const now = Date.now();
    resetStorage([now - 1000, now - 2000]);
    const stats = await getGovernorStats();
    expect(stats.callsLastHour).toBe(2);
    expect(stats.callsLastDay).toBe(2);
    expect(stats.limitsPerHour).toBe(GOVERNOR_DEFAULTS.OPENAI_CALLS_PER_HOUR);
    expect(stats.limitsPerDay).toBe(GOVERNOR_DEFAULTS.OPENAI_CALLS_PER_DAY);
  });
});
