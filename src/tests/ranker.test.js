// src/tests/ranker.test.js
// Unit tests for ReplyRanker — Phase 4 Performance-Aware Ranking.
//
// Covers:
//   1. Performance classification thresholds (exact spec boundaries)
//   2. Percentile normalization
//   3. Per-reply performance score (weights as config, not literals)
//   4. impression_ratio (source post scaling)
//   5. Composite candidate_score formula
//   6. INVARIANT: relevance dominates over performance (key tradeoff test)
//   7. Recency decay
//   8. Novelty / diversity (MMR-lite)
//   9. Full rankCandidates pipeline output
//  10. Boundary cases from Phase 4 spec (499/500/9999/10000)

"use strict";

const {
  PERFORMANCE_CLASSES,
  PERFORMANCE_THRESHOLDS,
  DEFAULT_PERFORMANCE_WEIGHTS,
  DEFAULT_CANDIDATE_WEIGHTS,
  classifyPerformance,
  percentileRank,
  normalizeMetric,
  computeImpressionRatio,
  computePerformanceScore,
  computeRecencyScore,
  computeNoveltyScore,
  computeCandidateScore,
  buildNormalizationPools,
  rankCandidates,
} = require("../../src/background/ranker");

// ─────────────────────────────────────────────────────────────────────────────
// 1 & 10. Performance Classification — exact spec boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyPerformance — exact spec boundary values", () => {
  test("499 is BASELINE (just below MODERATE threshold)", () => {
    expect(classifyPerformance(499)).toBe(PERFORMANCE_CLASSES.BASELINE);
  });

  test("500 is MODERATE (inclusive lower bound)", () => {
    expect(classifyPerformance(500)).toBe(PERFORMANCE_CLASSES.MODERATE);
  });

  test("9999 is MODERATE (just below OUTSTANDING threshold)", () => {
    expect(classifyPerformance(9999)).toBe(PERFORMANCE_CLASSES.MODERATE);
  });

  test("10000 is OUTSTANDING (inclusive lower bound)", () => {
    expect(classifyPerformance(10000)).toBe(PERFORMANCE_CLASSES.OUTSTANDING);
  });

  // Additional boundary sanity
  test("0 is BASELINE", () => {
    expect(classifyPerformance(0)).toBe(PERFORMANCE_CLASSES.BASELINE);
  });

  test("1 is BASELINE", () => {
    expect(classifyPerformance(1)).toBe(PERFORMANCE_CLASSES.BASELINE);
  });

  test("999999 is OUTSTANDING", () => {
    expect(classifyPerformance(999999)).toBe(PERFORMANCE_CLASSES.OUTSTANDING);
  });

  test("PERFORMANCE_THRESHOLDS constants are correct", () => {
    expect(PERFORMANCE_THRESHOLDS.OUTSTANDING_MIN).toBe(10000);
    expect(PERFORMANCE_THRESHOLDS.MODERATE_MIN).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Percentile Normalization
// ─────────────────────────────────────────────────────────────────────────────

describe("percentileRank", () => {
  test("returns 0 for empty pool", () => {
    expect(percentileRank(100, [])).toBe(0);
  });

  test("returns 0.5 when all pool values equal", () => {
    expect(percentileRank(50, [50, 50, 50])).toBe(0.5);
  });

  test("max value returns 1.0", () => {
    const pool = [10, 50, 100, 200];
    expect(percentileRank(200, pool)).toBeCloseTo(1.0);
  });

  test("min value returns 0.0", () => {
    const pool = [10, 50, 100, 200];
    expect(percentileRank(10, pool)).toBeCloseTo(0.0);
  });

  test("mid-range value is proportional", () => {
    const pool = [0, 100];
    expect(percentileRank(50, pool)).toBeCloseTo(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Performance Score — weights must come from config, not literals
// ─────────────────────────────────────────────────────────────────────────────

describe("computePerformanceScore — weight configurability", () => {
  const pool = buildNormalizationPools([
    { impressions: 0, likes: 0, replies: 0, reposts: 0, bookmarks: 0, profile_visits: 0 },
    { impressions: 20000, likes: 500, replies: 100, reposts: 200, bookmarks: 50, profile_visits: 300 },
  ]);

  test("high-engagement reply scores significantly higher than zero-engagement", () => {
    const highReply = { impressions: 20000, likes: 500, replies: 100, reposts: 200, bookmarks: 50, profile_visits: 300, author_replied: true };
    const zeroReply = { impressions: 0, likes: 0, replies: 0, reposts: 0, bookmarks: 0, profile_visits: 0 };

    const highResult = computePerformanceScore(highReply, pool);
    const zeroResult = computePerformanceScore(zeroReply, pool);

    expect(highResult.performance_score).toBeGreaterThan(zeroResult.performance_score);
    expect(highResult.performance_score).toBeGreaterThan(0.5);
    expect(zeroResult.performance_score).toBeCloseTo(0.0, 1);
  });

  test("author_reply_bonus increases score", () => {
    const base  = { impressions: 1000, likes: 50, replies: 5, reposts: 10, bookmarks: 2, profile_visits: 10, author_replied: false };
    const bonus = { ...base, author_replied: true };

    const baseResult  = computePerformanceScore(base,  pool);
    const bonusResult = computePerformanceScore(bonus, pool);
    expect(bonusResult.performance_score).toBeGreaterThan(baseResult.performance_score);
  });

  test("negative_feedback_penalty reduces score", () => {
    const clean  = { impressions: 5000, likes: 200, replies: 30, reposts: 50, bookmarks: 10, profile_visits: 40, negative_feedback: false };
    const penalized = { ...clean, negative_feedback: true };

    const cleanResult = computePerformanceScore(clean,     pool);
    const penResult   = computePerformanceScore(penalized, pool);
    expect(cleanResult.performance_score).toBeGreaterThan(penResult.performance_score);
  });

  test("score is clamped to [0, 1]", () => {
    const extreme = { impressions: 999999, likes: 9999, replies: 9999, reposts: 9999, bookmarks: 9999, profile_visits: 9999, author_replied: true };
    const result = computePerformanceScore(extreme, pool);
    expect(result.performance_score).toBeGreaterThanOrEqual(0);
    expect(result.performance_score).toBeLessThanOrEqual(1);
  });

  test("performance_class is correctly classified", () => {
    const outstanding = { impressions: 15000, likes: 0, replies: 0, reposts: 0, bookmarks: 0, profile_visits: 0 };
    const moderate    = { impressions: 2500,  likes: 0, replies: 0, reposts: 0, bookmarks: 0, profile_visits: 0 };
    const baseline    = { impressions: 200,   likes: 0, replies: 0, reposts: 0, bookmarks: 0, profile_visits: 0 };

    expect(computePerformanceScore(outstanding, {}).performance_class).toBe(PERFORMANCE_CLASSES.OUTSTANDING);
    expect(computePerformanceScore(moderate,    {}).performance_class).toBe(PERFORMANCE_CLASSES.MODERATE);
    expect(computePerformanceScore(baseline,    {}).performance_class).toBe(PERFORMANCE_CLASSES.BASELINE);
  });

  test("custom weight override changes the result", () => {
    const reply = { impressions: 1000, likes: 10, replies: 5, reposts: 5, bookmarks: 2, profile_visits: 5 };
    const defaultResult = computePerformanceScore(reply, pool);
    const allLikesWeights = {
      ...DEFAULT_PERFORMANCE_WEIGHTS,
      impressions: 0.01,
      likes: 0.97,
    };
    const likesResult = computePerformanceScore(reply, pool, allLikesWeights);
    // Results should differ because weights differ
    expect(defaultResult.performance_score).not.toBe(likesResult.performance_score);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. impression_ratio — viral source post scaling
// ─────────────────────────────────────────────────────────────────────────────

describe("computeImpressionRatio", () => {
  test("returns correct ratio when source impressions available", () => {
    const ratio = computeImpressionRatio(2000, 100000);
    expect(ratio).toBeCloseTo(0.02, 4);
  });

  test("returns null when source_post_impressions is not available", () => {
    expect(computeImpressionRatio(5000, null)).toBeNull();
    expect(computeImpressionRatio(5000, 0)).toBeNull();
    expect(computeImpressionRatio(5000, undefined)).toBeNull();
  });

  test("reply under mega-viral tweet gets low ratio even with high absolute impressions", () => {
    // A reply with 10k impressions under a 1M-impression tweet = 1% ratio
    const ratio = computeImpressionRatio(10000, 1000000);
    expect(ratio).toBeCloseTo(0.01, 4);
    // Compare: same reply without viral source would hit OUTSTANDING on absolute
    expect(classifyPerformance(10000)).toBe(PERFORMANCE_CLASSES.OUTSTANDING);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 & 6. Composite candidate_score — CRITICAL INVARIANT TEST
// ─────────────────────────────────────────────────────────────────────────────

describe("computeCandidateScore — INVARIANT: relevance dominates over performance", () => {
  // This test is the spec's explicit requirement:
  // "construct a case with high-performance/low-relevance vs
  //  low-performance/high-relevance and confirm relevance wins"

  test("high-relevance/low-performance beats high-performance/low-relevance", () => {
    const highRelevanceLowPerf = computeCandidateScore(
      { similarity_score: 0.92 },             // very high semantic similarity
      {
        topic_similarity: 1.0,                // exact topic match
        strategy_match: 1.0,                  // exact strategy match
        voice_similarity: 0.85,
        recency_score: 0.8,
        novelty_score: 0.9,
      },
      0.05,                                   // very low performance score
    );

    const lowRelevanceHighPerf = computeCandidateScore(
      { similarity_score: 0.12 },             // very low semantic similarity
      {
        topic_similarity: 0.0,                // topic mismatch
        strategy_match: 0.0,                  // strategy mismatch
        voice_similarity: 0.1,
        recency_score: 0.2,
        novelty_score: 0.3,
      },
      0.99,                                   // very high performance score
    );

    // INVARIANT must hold
    expect(highRelevanceLowPerf.candidate_score)
      .toBeGreaterThan(lowRelevanceHighPerf.candidate_score);

    // Relevance base must dominate
    expect(highRelevanceLowPerf.relevance_base)
      .toBeGreaterThan(lowRelevanceHighPerf.relevance_base);
  });

  test("performance_bonus is capped at DEFAULT_CANDIDATE_WEIGHTS.performance_bonus_cap", () => {
    const result = computeCandidateScore(
      { similarity_score: 0 },
      { topic_similarity: 0, strategy_match: 0, voice_similarity: 0, recency_score: 0, novelty_score: 0 },
      1.0,  // max performance score
    );
    expect(result.performance_bonus)
      .toBeLessThanOrEqual(DEFAULT_CANDIDATE_WEIGHTS.performance_bonus_cap + 0.0001);
  });

  test("candidate_score is clamped to [0, 1]", () => {
    const result = computeCandidateScore(
      { similarity_score: 1.0 },
      { topic_similarity: 1.0, strategy_match: 1.0, voice_similarity: 1.0, recency_score: 1.0, novelty_score: 1.0 },
      1.0,
    );
    expect(result.candidate_score).toBeLessThanOrEqual(1.0);
    expect(result.candidate_score).toBeGreaterThanOrEqual(0.0);
  });

  test("zero-everything produces candidate_score of 0", () => {
    const result = computeCandidateScore(
      { similarity_score: 0 },
      { topic_similarity: 0, strategy_match: 0, voice_similarity: 0, recency_score: 0, novelty_score: 0 },
      0,
    );
    expect(result.candidate_score).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Recency Score
// ─────────────────────────────────────────────────────────────────────────────

describe("computeRecencyScore", () => {
  test("score is 1.0 (or very close) for just-created content", () => {
    const justNow = new Date().toISOString();
    expect(computeRecencyScore(justNow)).toBeCloseTo(1.0, 2);
  });

  test("score decays below 0.5 past the half-life", () => {
    const halfLifeDays = 60;
    const oldDate = new Date(Date.now() - (halfLifeDays + 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(computeRecencyScore(oldDate, halfLifeDays)).toBeLessThan(0.5);
  });

  test("very old content scores near 0", () => {
    const veryOld = "2020-01-01T00:00:00.000Z";
    expect(computeRecencyScore(veryOld)).toBeLessThan(0.05);
  });

  test("returns 0 for null/missing created_at", () => {
    expect(computeRecencyScore(null)).toBe(0);
    expect(computeRecencyScore(undefined)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Novelty Score
// ─────────────────────────────────────────────────────────────────────────────

describe("computeNoveltyScore (MMR-lite)", () => {
  test("first candidate is fully novel (1.0)", () => {
    expect(computeNoveltyScore("Some reply text", [])).toBe(1.0);
  });

  test("exact duplicate of an already-ranked reply gets low novelty", () => {
    const text = "Building in public is the best distribution strategy";
    const score = computeNoveltyScore(text, [text]);
    expect(score).toBeCloseTo(0.0, 1);
  });

  test("completely different reply remains novel", () => {
    const alreadyRanked = ["Building in public is the best distribution strategy"];
    const differentText = "Machine learning model fine-tuning vs RAG pipelines";
    const score = computeNoveltyScore(differentText, alreadyRanked);
    expect(score).toBeGreaterThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Full rankCandidates pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("rankCandidates — full pipeline", () => {
  test("returns empty array for empty candidates", () => {
    expect(rankCandidates([], {}, [])).toEqual([]);
  });

  test("injects all score fields into ranked candidates", () => {
    const candidates = [
      { id: "r1", reply_text: "Great strategy for SaaS",    similarity_score: 0.82, topic: "saas_builder", impressions: 5000, likes: 200, replies: 20, reposts: 40, bookmarks: 10, profile_visits: 30, created_at: new Date().toISOString() },
      { id: "r2", reply_text: "Another take on marketing",  similarity_score: 0.45, topic: "marketing",    impressions: 300,  likes: 10,  replies: 2,  reposts: 5,  bookmarks: 1,  profile_visits: 8,  created_at: new Date().toISOString() },
    ];

    const ranked = rankCandidates(
      candidates,
      { topic: "saas_builder" },
      candidates,
    );

    expect(ranked).toHaveLength(2);
    const top = ranked[0];
    expect(top).toHaveProperty("candidate_score");
    expect(top).toHaveProperty("relevance_base");
    expect(top).toHaveProperty("performance_bonus");
    expect(top).toHaveProperty("performance_score");
    expect(top).toHaveProperty("performance_class");
    expect(top).toHaveProperty("recency_score");
    expect(top).toHaveProperty("novelty_score");
    expect(top).toHaveProperty("score_components");
    expect(top.candidate_score).toBeGreaterThanOrEqual(ranked[1].candidate_score);
  });

  test("outputs sorted descending by candidate_score", () => {
    const candidates = [
      { id: "low",  reply_text: "Vague generic comment",           similarity_score: 0.1,  topic: null,          impressions: 100,   likes: 2,   replies: 0,  reposts: 1,  bookmarks: 0, profile_visits: 2,  created_at: "2022-01-01T00:00:00Z" },
      { id: "high", reply_text: "Very specific SaaS growth advice", similarity_score: 0.88, topic: "saas_builder", impressions: 12000, likes: 500, replies: 80, reposts: 200, bookmarks: 50, profile_visits: 150, created_at: new Date().toISOString() },
      { id: "mid",  reply_text: "Moderate quality builder reply",   similarity_score: 0.5,  topic: "saas_builder", impressions: 1500,  likes: 60,  replies: 10, reposts: 20, bookmarks: 5,  profile_visits: 25, created_at: new Date().toISOString() },
    ];

    const ranked = rankCandidates(candidates, { topic: "saas_builder" }, candidates);
    const scores = ranked.map(c => c.candidate_score);

    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Default weights are exported as config constants, not literals
// ─────────────────────────────────────────────────────────────────────────────

describe("Weight configuration surface", () => {
  test("DEFAULT_PERFORMANCE_WEIGHTS is exported and all expected keys present", () => {
    const keys = ["impressions", "likes", "reply_count", "reposts", "bookmarks", "profile_visits", "author_reply_bonus", "negative_feedback_penalty"];
    keys.forEach(k => expect(DEFAULT_PERFORMANCE_WEIGHTS).toHaveProperty(k));
  });

  test("DEFAULT_CANDIDATE_WEIGHTS is exported and all expected keys present", () => {
    const keys = ["semantic_similarity", "topic_similarity", "strategy_match", "voice_similarity", "recency_score", "novelty_score", "performance_bonus_cap", "performance_bonus_weight"];
    keys.forEach(k => expect(DEFAULT_CANDIDATE_WEIGHTS).toHaveProperty(k));
  });
});
