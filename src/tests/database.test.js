// src/tests/database.test.js
// Unit tests for IndexedDB database connection, migrations, repositories, and indexes.

"use strict";

const {
  openDatabase,
  closeDatabase,
  resetDatabase,
  repliesRepo,
  voiceProfilesRepo,
  replyPatternsRepo,
  generationRunsRepo,
} = require("../../src/background/db/database");
const { STORES } = require("../../src/background/db/schema");
const { MIGRATIONS, runMigrations } = require("../../src/background/db/migrations");

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
});

describe("Database & Migrations", () => {
  test("opens database and executes version 1 migration creating all stores", async () => {
    const db = await openDatabase();
    expect(db.objectStoreNames.contains(STORES.REPLIES)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.VOICE_PROFILES)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.REPLY_PATTERNS)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.GENERATION_RUNS)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.RETENTION_META)).toBe(true);
  });

  test("migrations are reversible (up and down functions work properly)", () => {
    const v1 = MIGRATIONS.find(m => m.version === 1);
    expect(v1).toBeDefined();
    expect(typeof v1.up).toBe("function");
    expect(typeof v1.down).toBe("function");
  });
});

describe("repliesRepo CRUD & Indexes", () => {
  test("inserts, gets, updates, and deletes a reply record", async () => {
    const created = await repliesRepo.insertReply({
      source_post_id: "tweet_001",
      source_tweet_text: "What is your favorite stack?",
      source_tweet_author_handle: "@devguy",
      reply_text: "Node + Postgres + Vanilla CSS.",
      topic: "tech",
      reply_strategy: "direct_answer",
      is_ai_generated: true,
    });

    expect(created.id).toBeDefined();

    const fetched = await repliesRepo.getReplyById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched.reply_text).toBe("Node + Postgres + Vanilla CSS.");

    const updated = await repliesRepo.updateReply(created.id, {
      likes: 10,
      impressions: 500,
      author_replied: true,
    });
    expect(updated.likes).toBe(10);
    expect(updated.impressions).toBe(500);
    expect(updated.author_replied).toBe(true);

    await repliesRepo.deleteReply(created.id);
    const afterDelete = await repliesRepo.getReplyById(created.id);
    expect(afterDelete).toBeNull();
  });

  test("queries replies by topic index", async () => {
    await repliesRepo.insertReply({ topic: "ai", reply_text: "AI reply 1" });
    await repliesRepo.insertReply({ topic: "ai", reply_text: "AI reply 2" });
    await repliesRepo.insertReply({ topic: "marketing", reply_text: "Marketing reply 1" });

    const aiReplies = await repliesRepo.getRepliesByTopic("ai");
    expect(aiReplies).toHaveLength(2);
    expect(aiReplies.every(r => r.topic === "ai")).toBe(true);
  });

  test("queries replies by strategy index", async () => {
    await repliesRepo.insertReply({ reply_strategy: "curious_question", reply_text: "Why?" });
    await repliesRepo.insertReply({ reply_strategy: "contrarian_take", reply_text: "Disagree." });

    const questionReplies = await repliesRepo.getRepliesByStrategy("curious_question");
    expect(questionReplies).toHaveLength(1);
    expect(questionReplies[0].reply_text).toBe("Why?");
  });

  test("gets recent replies ordered descending", async () => {
    await repliesRepo.insertReply({ reply_text: "First", created_at: "2026-08-28T00:00:00.000Z" });
    await repliesRepo.insertReply({ reply_text: "Second", created_at: "2026-08-28T01:00:00.000Z" });

    const recent = await repliesRepo.getRecentReplies(5);
    expect(recent).toHaveLength(2);
    expect(recent[0].reply_text).toBe("Second");
  });
});

describe("voiceProfilesRepo Versioning & Active State", () => {
  test("saves versioned voice profile and activates it, deactivating older profiles", async () => {
    const vp1 = await voiceProfilesRepo.saveVoiceProfile({
      version: 1,
      is_active: true,
      sample_size: 10,
      avg_length: 90,
      tone: "Witty",
    });

    let active = await voiceProfilesRepo.getActiveVoiceProfile();
    expect(active.version).toBe(1);

    const vp2 = await voiceProfilesRepo.saveVoiceProfile({
      version: 2,
      is_active: true,
      sample_size: 20,
      avg_length: 110,
      tone: "Direct",
    });

    active = await voiceProfilesRepo.getActiveVoiceProfile();
    expect(active.version).toBe(2);
    expect(active.tone).toBe("Direct");

    const oldV1 = await voiceProfilesRepo.getVoiceProfileByVersion(1);
    expect(oldV1.is_active).toBe(0);

    const all = await voiceProfilesRepo.getAllVoiceProfiles();
    expect(all).toHaveLength(2);
  });
});

describe("replyPatternsRepo", () => {
  test("saves and queries reply patterns by strategy and topic", async () => {
    await replyPatternsRepo.saveReplyPattern({
      reply_id: "rep_100",
      strategy: "hook_question",
      topic: "saas",
      impressions: 1200,
      engagement_rate: 0.08,
    });

    const patterns = await replyPatternsRepo.getPatternsByStrategy("hook_question");
    expect(patterns).toHaveLength(1);
    expect(patterns[0].topic).toBe("saas");
    expect(patterns[0].engagement_rate).toBe(0.08);

    const topicPatterns = await replyPatternsRepo.getPatternsByTopic("saas");
    expect(topicPatterns).toHaveLength(1);
  });
});

describe("generationRunsRepo (A/B Testing Telemetry)", () => {
  test("saves generation run and queries by prompt_version", async () => {
    await generationRunsRepo.saveGenerationRun({
      prompt_version: "prompt_v1_baseline",
      model: "gpt-4o-mini",
      selected_strategy: "direct",
      output_reply: "Candidate 1",
      quality_score: 0.85,
    });

    await generationRunsRepo.saveGenerationRun({
      prompt_version: "prompt_v2_experiment",
      model: "gpt-4o-mini",
      selected_strategy: "contrarian",
      output_reply: "Candidate 2",
      quality_score: 0.94,
    });

    const v1Runs = await generationRunsRepo.getGenerationRunsByPromptVersion("prompt_v1_baseline");
    const v2Runs = await generationRunsRepo.getGenerationRunsByPromptVersion("prompt_v2_experiment");

    expect(v1Runs).toHaveLength(1);
    expect(v1Runs[0].quality_score).toBe(0.85);

    expect(v2Runs).toHaveLength(1);
    expect(v2Runs[0].quality_score).toBe(0.94);
  });
});
