// src/tests/schema.test.js
// Unit tests for database schema definitions, validators, and record factories.

"use strict";

const {
  DB_NAME,
  DB_VERSION,
  STORES,
  STORE_INDEXES,
  createReplyRecord,
  createVoiceProfileRecord,
  createReplyPatternRecord,
  createGenerationRunRecord,
} = require("../../src/background/db/schema");

describe("Database Schema Definitions", () => {
  test("defines DB_NAME and DB_VERSION", () => {
    expect(DB_NAME).toBe("ReplyGenieDB");
    expect(DB_VERSION).toBe(1);
  });

  test("defines all required store names", () => {
    expect(STORES.REPLIES).toBe("replies");
    expect(STORES.VOICE_PROFILES).toBe("voice_profiles");
    expect(STORES.REPLY_PATTERNS).toBe("reply_patterns");
    expect(STORES.GENERATION_RUNS).toBe("generation_runs");
    expect(STORES.RETENTION_META).toBe("retention_meta");
  });

  test("defines expected indexes for each store", () => {
    expect(STORE_INDEXES[STORES.REPLIES].length).toBeGreaterThanOrEqual(10);
    expect(STORE_INDEXES[STORES.VOICE_PROFILES].some(i => i.name === "version")).toBe(true);
    expect(STORE_INDEXES[STORES.REPLY_PATTERNS].some(i => i.name === "strategy")).toBe(true);
    expect(STORE_INDEXES[STORES.GENERATION_RUNS].some(i => i.name === "prompt_version")).toBe(true);
  });
});

describe("createReplyRecord factory", () => {
  test("creates a complete reply record with all Phase 2 extended fields", () => {
    const record = createReplyRecord({
      source_post_id: "tweet_123",
      source_tweet_text: "Building AI apps is fun",
      source_tweet_author_handle: "@builder",
      reply_text: "Totally agree with this direction.",
      impressions: 1500,
      likes: 45,
      replies: 8,
      reposts: 5,
      bookmarks: 12,
      profile_visits: 20,
      author_replied: true,
      negative_feedback: false,
      performance_class: "high",
      performance_score: 88.5,
      topic: "ai",
      intent: "connect",
      reply_strategy: "curious_question",
      embedding: [0.12, -0.45, 0.89],
      voice_similarity_score: 0.92,
      semantic_similarity_score: 0.88,
      is_human_written: false,
      is_ai_generated: true,
      is_reused: false,
      is_adapted: false,
      generation_model: "gpt-4o-mini",
      generation_prompt_version: "prompt_v1.0.0",
      quality_score: 0.95,
      accuracy_score: 0.9,
      specificity_score: 0.85,
      human_score: 0.92,
      genericity_score: 0.1,
    });

    expect(record.id).toMatch(/^rep_/);
    expect(record.source_post_id).toBe("tweet_123");
    expect(record.source_tweet_text).toBe("Building AI apps is fun");
    expect(record.source_tweet_author_handle).toBe("@builder");
    expect(record.reply_text).toBe("Totally agree with this direction.");
    expect(record.impressions).toBe(1500);
    expect(record.likes).toBe(45);
    expect(record.replies).toBe(8);
    expect(record.reposts).toBe(5);
    expect(record.bookmarks).toBe(12);
    expect(record.profile_visits).toBe(20);
    expect(record.author_replied).toBe(true);
    expect(record.negative_feedback).toBe(false);
    expect(record.performance_class).toBe("high");
    expect(record.performance_score).toBe(88.5);
    expect(record.topic).toBe("ai");
    expect(record.intent).toBe("connect");
    expect(record.reply_strategy).toBe("curious_question");
    expect(record.embedding).toEqual([0.12, -0.45, 0.89]);
    expect(record.voice_similarity_score).toBe(0.92);
    expect(record.semantic_similarity_score).toBe(0.88);
    expect(record.is_human_written).toBe(0);
    expect(record.is_ai_generated).toBe(1);
    expect(record.generation_model).toBe("gpt-4o-mini");
    expect(record.generation_prompt_version).toBe("prompt_v1.0.0");
    expect(record.quality_score).toBe(0.95);
    expect(record.accuracy_score).toBe(0.9);
    expect(record.specificity_score).toBe(0.85);
    expect(record.human_score).toBe(0.92);
    expect(record.genericity_score).toBe(0.1);
    expect(record.raw_text_purged).toBe(0);
    expect(record.created_at).toBeDefined();
    expect(record.last_updated_at).toBeDefined();
  });

  test("applies sensible defaults when given empty object", () => {
    const record = createReplyRecord({});
    expect(record.impressions).toBe(0);
    expect(record.likes).toBe(0);
    expect(record.author_replied).toBe(false);
    expect(record.is_ai_generated).toBe(0);
    expect(record.is_human_written).toBe(0);
    expect(record.embedding).toBeNull();
    expect(record.raw_text_purged).toBe(0);
  });
});

describe("createVoiceProfileRecord factory", () => {
  test("creates a voice profile record with all required style signals", () => {
    const profile = createVoiceProfileRecord({
      version: 2,
      is_active: true,
      sample_size: 25,
      avg_length: 120,
      sentence_length: 14,
      punctuation_patterns: { exclamation: 0.05, question: 0.15, ellipsis: 0.02 },
      vocabulary: { frequent_words: ["ship", "build", "metrics"], unique_word_ratio: 0.65, jargon_density: 0.12 },
      recurring_expressions: ["ship fast", "the moat is distribution"],
      tone: "Direct & Analytical",
      directness: 0.85,
      humor_frequency: 0.2,
      question_frequency: 0.4,
      emoji_frequency: 0.05,
      formatting_patterns: { lowercase_start: false, bullet_points_used: false, line_break_frequency: 0.3 },
    });

    expect(profile.version).toBe(2);
    expect(profile.is_active).toBe(1);
    expect(profile.sample_size).toBe(25);
    expect(profile.avg_length).toBe(120);
    expect(profile.sentence_length).toBe(14);
    expect(profile.punctuation_patterns.question).toBe(0.15);
    expect(profile.vocabulary.frequent_words).toContain("ship");
    expect(profile.recurring_expressions).toContain("ship fast");
    expect(profile.directness).toBe(0.85);
    expect(profile.last_trained_at).toBeDefined();
  });
});

describe("createReplyPatternRecord factory", () => {
  test("creates a reply pattern record with all analytical dimensions", () => {
    const pattern = createReplyPatternRecord({
      reply_id: "rep_456",
      strategy: "contrarian_reframe",
      topic: "saas",
      length: 110,
      hook_type: "bold_statement",
      sentence_count: 2,
      question_present: true,
      specificity: 0.8,
      contrarian_level: 0.9,
      humor_level: 0.1,
      technical_depth: 0.7,
      personal_experience: true,
      example_present: true,
      numbers_present: true,
      author_response: true,
      impressions: 3200,
      engagement_rate: 0.045,
      profile_visit_rate: 0.012,
    });

    expect(pattern.strategy).toBe("contrarian_reframe");
    expect(pattern.topic).toBe("saas");
    expect(pattern.hook_type).toBe("bold_statement");
    expect(pattern.question_present).toBe(1);
    expect(pattern.specificity).toBe(0.8);
    expect(pattern.contrarian_level).toBe(0.9);
    expect(pattern.personal_experience).toBe(true);
    expect(pattern.numbers_present).toBe(true);
    expect(pattern.author_response).toBe(1);
    expect(pattern.engagement_rate).toBe(0.045);
  });
});

describe("createGenerationRunRecord factory", () => {
  test("creates a generation run telemetry record for A/B testing", () => {
    const run = createGenerationRunRecord({
      source_post_id: "post_999",
      prompt_version: "v1.2.0_experiment_a",
      model: "gpt-4o-mini",
      temperature: 0.7,
      params: { max_tokens: 150, length_setting: "Long", tone_setting: "Witty" },
      retrieved_reply_ids: ["rep_1", "rep_2"],
      selected_strategy: "curiosity_gap",
      output_reply: "What was the tipping point in your growth?",
      generated_reply_id: "rep_target_123",
      quality_score: 0.92,
      accuracy_score: 0.9,
      specificity_score: 0.88,
      human_score: 0.94,
      genericity_score: 0.05,
      voice_fit_score: 0.91,
      latency_ms: 1250,
      status: "success",
    });

    expect(run.prompt_version).toBe("v1.2.0_experiment_a");
    expect(run.temperature).toBe(0.7);
    expect(run.retrieved_reply_ids).toHaveLength(2);
    expect(run.quality_score).toBe(0.92);
    expect(run.voice_fit_score).toBe(0.91);
    expect(run.latency_ms).toBe(1250);
    expect(run.status).toBe("success");
  });
});
