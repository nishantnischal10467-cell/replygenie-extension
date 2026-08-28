// src/tests/profiler.test.js
// Unit tests for Phase 8 — Voice Profiler.
//
// Covers:
//   1. extractTextFeatures: lengths, punctuation, jargon, hedging, humor, fragments
//   2. extractNGrams: bigram and trigram extraction with stopword filtering
//   3. trainVoiceProfile: performance weighting (OUTSTANDING 5x, MODERATE 2x, BASELINE 1x)
//   4. trainVoiceProfile: negative signal suppression (from Phase 6/7 rejections)
//   5. trainVoiceProfile: grammatical non-smoothing (preserves lowercase start, fragment endings)
//   6. trainVoiceProfile: versioning and metadata (version, sample_size, last_trained_at)
//   7. formatVoiceProfileForPrompt: prompt generation with observable rules only

"use strict";

const {
  PROFILER_VERSION,
  PERFORMANCE_WEIGHTS,
  extractTextFeatures,
  extractNGrams,
  trainVoiceProfile,
  formatVoiceProfileForPrompt,
} = require("../../src/background/profiler");

describe("Phase 8 — extractTextFeatures", () => {
  test("extracts lengths, word counts, and sentence counts accurately", () => {
    const text = "We migrated our database to Postgres. The p99 latency dropped by 45%.";
    const feat = extractTextFeatures(text);

    expect(feat.wordCount).toBe(12);
    expect(feat.sentenceCount).toBe(2);
    expect(feat.hasNumbers).toBe(true);
    expect(feat.hasPersonalExperience).toBe(true); // "We"
    expect(feat.jargonCount).toBeGreaterThan(0); // "database", "postgres", "p99", "latency"
  });

  test("accurately counts punctuation patterns and case formatting", () => {
    const fragment = "building in public — the hard part is staying consistent...";
    const feat = extractTextFeatures(fragment);

    expect(feat.isLowercaseStart).toBe(true);
    expect(feat.hasTrailingPeriod).toBe(false);
    expect(feat.emDashCount).toBe(1);
    expect(feat.ellipsisCount).toBe(1);
  });

  test("detects hedging words and humor markers", () => {
    const text = "Maybe we could try this lol 😅";
    const feat = extractTextFeatures(text);

    expect(feat.hasHedging).toBe(true);
    expect(feat.hasHumor).toBe(true);
    expect(feat.hasEmoji).toBe(true);
  });
});

describe("Phase 8 — extractNGrams", () => {
  test("extracts meaningful bigrams and trigrams without pure stopword pairs", () => {
    const tokens = ["redis", "cache", "latency", "drop"];
    const ngrams = extractNGrams(tokens);

    expect(ngrams).toContain("redis cache");
    expect(ngrams).toContain("cache latency");
    expect(ngrams).toContain("redis cache latency");
  });
});

describe("Phase 8 — trainVoiceProfile & Performance Weighting", () => {
  test("weights OUTSTANDING (5x) examples much higher than BASELINE (1x)", () => {
    const outstandingSample = {
      text: "Memory profiling in WebAssembly is straightforward with heap snapshots.", // Short, technical, direct
      performance_class: "outstanding",
      topic: "engineering",
    };

    const baselineSample = {
      text: "Maybe I think we should perhaps consider looking at our general strategy for long term growth?", // Long, hedged
      performance_class: "baseline",
      topic: "general",
    };

    const profile = trainVoiceProfile([outstandingSample, baselineSample]);

    // Outstanding sample has 5x weight vs baseline 1x
    // Directness should be high because outstanding has no hedging and 5x weight
    expect(profile.directness).toBeGreaterThan(0.75);
    expect(profile.sample_size).toBe(2);
    expect(profile.version).toBe(1);
    expect(profile.is_active).toBe(1);
  });

  test("preserves informal lowercase start and fragments without grammatical smoothing", () => {
    const samples = [
      { text: "shipping fast is the only moat that compounds", performance_class: "outstanding" },
      { text: "distribution beats product every single time", performance_class: "outstanding" },
    ];

    const profile = trainVoiceProfile(samples);

    expect(profile.formatting_patterns.lowercase_start).toBe(true);
    expect(profile.punctuation_patterns.trailing_periods).toBeLessThan(0.1);
  });

  test("negative samples pull question frequency down", () => {
    const positiveSamples = [
      { text: "Adding indexes on foreign keys cut our query times in half.", performance_class: "outstanding" },
      { text: "What do you think about database indexing?", performance_class: "baseline" },
    ];

    const negativeSamples = [
      { text: "Great insights! Thoughts?", failure_tag: "FORCED_QUESTION" },
      { text: "What are your thoughts on this?", failure_tag: "FORCED_QUESTION" },
    ];

    const profileWithNegatives = trainVoiceProfile(positiveSamples, negativeSamples);
    const profileWithoutNegatives = trainVoiceProfile(positiveSamples, []);

    expect(profileWithNegatives.question_frequency).toBeLessThanOrEqual(profileWithoutNegatives.question_frequency);
  });

  test("increments version number and updates timestamps on subsequent training", () => {
    const previous = {
      id: "vp_v1_123",
      version: 1,
      created_at: "2026-08-01T00:00:00.000Z",
    };

    const samples = [{ text: "Continuous deployment requires high test coverage.", performance_class: "outstanding" }];
    const updated = trainVoiceProfile(samples, [], previous);

    expect(updated.version).toBe(2);
    expect(updated.created_at).toBe("2026-08-01T00:00:00.000Z");
    expect(updated.last_trained_at).toBeDefined();
  });
});

describe("Phase 8 — formatVoiceProfileForPrompt", () => {
  test("generates formatted prompt directives without hallucinated tropes", () => {
    const profile = {
      version: 2,
      sample_size: 15,
      tone: "Direct",
      directness: 0.9,
      avg_words: 18,
      sentence_length: 12,
      punctuation_patterns: {
        question: 0.05,
        exclamation: 0.02,
        em_dash: 0.40,
        trailing_periods: 0.20,
      },
      formatting_patterns: {
        lowercase_start: true,
      },
      vocabulary: {
        technical_vocabulary: ["latency", "postgres", "cache", "redis"],
      },
      recurring_expressions: ["building in public", "shipping fast"],
      use_of_numbers: 0.45,
      disagreement_frequency: 0.30,
    };

    const prompt = formatVoiceProfileForPrompt(profile);

    expect(prompt).toContain("LEARNED VOICE PROFILE (v2 — trained on 15 samples)");
    expect(prompt).toContain("Dominant Tone: Direct");
    expect(prompt).toContain("Rarely ask questions");
    expect(prompt).toContain("Avoid exclamation marks");
    expect(prompt).toContain("em-dashes (—)");
    expect(prompt).toContain("Informal lowercase opening permitted");
    expect(prompt).toContain("latency, postgres, cache, redis");
    expect(prompt).toContain("building in public");
    expect(prompt).toContain("Empirical style");
  });

  test("returns empty string when profile is null", () => {
    expect(formatVoiceProfileForPrompt(null)).toBe("");
  });
});
