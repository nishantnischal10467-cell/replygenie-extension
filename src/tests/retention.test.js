// src/tests/retention.test.js
// Unit tests for Data Retention Engine and GDPR compliance cleanup.

"use strict";

const {
  runDataRetentionJob,
  purgeAllUserData,
  RETENTION_CONFIG,
} = require("../../src/background/db/retention");
const {
  openDatabase,
  resetDatabase,
  repliesRepo,
  generationRunsRepo,
} = require("../../src/background/db/database");
const { STORES } = require("../../src/background/db/schema");

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
});

describe("Data Retention Engine", () => {
  test("purges raw source tweet text older than 90 days while preserving scores and metrics", async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // 100 days ago (should be purged)
    const oldDate = new Date(now - 100 * DAY_MS).toISOString();
    // 10 days ago (should NOT be purged)
    const recentDate = new Date(now - 10 * DAY_MS).toISOString();

    const oldReply = await repliesRepo.insertReply({
      created_at: oldDate,
      source_tweet_text: "Confidential third party tweet content from 100 days ago",
      reply_text: "My awesome reply",
      quality_score: 0.95,
      likes: 50,
      topic: "saas",
    });

    const recentReply = await repliesRepo.insertReply({
      created_at: recentDate,
      source_tweet_text: "Recent tweet content",
      reply_text: "Recent reply",
      quality_score: 0.88,
      likes: 12,
    });

    const stats = await runDataRetentionJob();
    expect(stats.raw_texts_purged).toBe(1);

    const oldFetched = await repliesRepo.getReplyById(oldReply.id);
    expect(oldFetched.source_tweet_text).toBe("[PURGED_RETENTION_TTL]");
    expect(oldFetched.raw_text_purged).toBe(1);
    // Verified: analytical data, scores, metrics, and reply text are preserved
    expect(oldFetched.reply_text).toBe("My awesome reply");
    expect(oldFetched.quality_score).toBe(0.95);
    expect(oldFetched.likes).toBe(50);
    expect(oldFetched.topic).toBe("saas");

    const recentFetched = await repliesRepo.getReplyById(recentReply.id);
    expect(recentFetched.source_tweet_text).toBe("Recent tweet content");
    expect(recentFetched.raw_text_purged).toBe(0);
  });

  test("deletes transient / failed generation runs older than 30 days", async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // 40 days ago failed run (should be deleted)
    const oldFailed = await generationRunsRepo.saveGenerationRun({
      timestamp: new Date(now - 40 * DAY_MS).toISOString(),
      status: "error",
      error_message: "Rate limit reached",
      output_reply: "",
      generated_reply_id: null,
    });

    // 40 days ago successful run associated with a reply (should be kept for A/B lineage)
    const oldSuccess = await generationRunsRepo.saveGenerationRun({
      timestamp: new Date(now - 40 * DAY_MS).toISOString(),
      status: "success",
      output_reply: "Generated text",
      generated_reply_id: "rep_linked_123",
    });

    // Recent failed run (should NOT be deleted yet)
    const recentFailed = await generationRunsRepo.saveGenerationRun({
      timestamp: new Date(now - 5 * DAY_MS).toISOString(),
      status: "error",
      generated_reply_id: null,
    });

    const stats = await runDataRetentionJob();
    expect(stats.transient_runs_deleted).toBe(1);

    const db = await openDatabase();
    const tx = db.transaction(STORES.GENERATION_RUNS, "readonly");
    const store = tx.objectStore(STORES.GENERATION_RUNS);

    const getReq = store.get(oldFailed.id);
    const oldFailedResult = await new Promise(res => { getReq.onsuccess = () => res(getReq.result); });
    expect(oldFailedResult).toBeUndefined();

    const getSuccessReq = store.get(oldSuccess.id);
    const oldSuccessResult = await new Promise(res => { getSuccessReq.onsuccess = () => res(getSuccessReq.result); });
    expect(oldSuccessResult).toBeDefined();

    const getRecentReq = store.get(recentFailed.id);
    const recentResult = await new Promise(res => { getRecentReq.onsuccess = () => res(getRecentReq.result); });
    expect(recentResult).toBeDefined();
  });

  test("records retention execution metadata in retention_meta store", async () => {
    await runDataRetentionJob();

    const db = await openDatabase();
    const tx = db.transaction(STORES.RETENTION_META, "readonly");
    const store = tx.objectStore(STORES.RETENTION_META);
    const all = await new Promise(res => {
      const req = store.getAll();
      req.onsuccess = () => res(req.result);
    });

    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all[0].job_type).toBe("daily_retention_sweep");
    expect(all[0].stats).toBeDefined();
  });

  test("purgeAllUserData resets database completely (GDPR right to be forgotten)", async () => {
    await repliesRepo.insertReply({ reply_text: "User data" });
    let count = await repliesRepo.countReplies();
    expect(count).toBe(1);

    await purgeAllUserData();

    count = await repliesRepo.countReplies();
    expect(count).toBe(0);
  });
});
