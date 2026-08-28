// src/tests/learning.test.js
// Unit tests for Phase 9 — Performance Collection & Learning Loop.
//
// Covers:
//   1. parseXMetricNumber: metric strings ("1.2K", "45", "10M")
//   2. checkScraperHealth: LIKELY_SCRAPER_BREAKAGE alert trigger
//   3. isScrapeDue: scheduled cadence intervals (~1hr, ~6hr, ~24hr, ~72hr)
//   4. classifyWithConfidence: confidence filtering (skips missing/unreliable reads)
//   5. extractConceptFeatures: conceptual feature extraction (data points, contrarian, tech depth)
//   6. minePatterns: conceptual learning across performance buckets
//   7. extractNegativePatterns: failure taxonomy avoidance directives
//   8. proposeRankingWeightAdjustments: weight proposal logging (proposed vs applied)

"use strict";

const {
  LEARNING_MODULE_VERSION,
  METRICS_CONFIDENCE,
  parseXMetricNumber,
  checkScraperHealth,
  isScrapeDue,
  classifyWithConfidence,
  extractConceptFeatures,
  minePatterns,
  extractNegativePatterns,
  proposeRankingWeightAdjustments,
} = require("../../src/background/learning");

describe("Phase 9 — parseXMetricNumber", () => {
  test("parses raw X DOM metric strings into clean numbers", () => {
    expect(parseXMetricNumber("45")).toBe(45);
    expect(parseXMetricNumber("1.2K")).toBe(1200);
    expect(parseXMetricNumber("10.5K")).toBe(10500);
    expect(parseXMetricNumber("2M")).toBe(2000000);
    expect(parseXMetricNumber("1,450")).toBe(1450);
    expect(parseXMetricNumber("0")).toBe(0);
    expect(parseXMetricNumber(null)).toBe(0);
    expect(parseXMetricNumber("")).toBe(0);
  });
});

describe("Phase 9 — checkScraperHealth", () => {
  test("flags LIKELY_SCRAPER_BREAKAGE when zero/missing ratio exceeds 70%", () => {
    const brokenBatch = [
      { reply_id: "r1", impressions: 0, metrics_confidence: "missing" },
      { reply_id: "r2", impressions: 0, metrics_confidence: "unreliable" },
      { reply_id: "r3", impressions: 0, metrics_confidence: "missing" },
      { reply_id: "r4", impressions: 0, metrics_confidence: "missing" },
      { reply_id: "r5", impressions: 120, metrics_confidence: "fresh" },
    ];

    const health = checkScraperHealth(brokenBatch);
    expect(health.isHealthy).toBe(false);
    expect(health.alert).toMatch(/LIKELY_SCRAPER_BREAKAGE/);
    expect(health.zeroRatio).toBeGreaterThan(0.70);
  });

  test("passes health check when normal proportion of replies have views", () => {
    const normalBatch = [
      { reply_id: "r1", impressions: 450, metrics_confidence: "fresh" },
      { reply_id: "r2", impressions: 1200, metrics_confidence: "fresh" },
      { reply_id: "r3", impressions: 0, metrics_confidence: "fresh" },
      { reply_id: "r4", impressions: 80, metrics_confidence: "fresh" },
      { reply_id: "r5", impressions: 3200, metrics_confidence: "fresh" },
    ];

    const health = checkScraperHealth(normalBatch);
    expect(health.isHealthy).toBe(true);
    expect(health.alert).toBeNull();
  });
});

describe("Phase 9 — isScrapeDue & Cadence", () => {
  test("triggers scheduled scrapes at 1h, 6h, 24h, 72h intervals", () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 65 * 60 * 1000).toISOString();

    const dueFirstScrape = isScrapeDue({ created_at: oneHourAgo, scrape_count: 0 }, now);
    expect(dueFirstScrape.isDue).toBe(true);
    expect(dueFirstScrape.targetIntervalHours).toBe(1);

    const notDueYet = isScrapeDue({ created_at: oneHourAgo, scrape_count: 1 }, now);
    expect(notDueYet.isDue).toBe(false);
    expect(notDueYet.targetIntervalHours).toBe(6);

    const pastLifecycle = isScrapeDue({ created_at: oneHourAgo, scrape_count: 4 }, now);
    expect(pastLifecycle.isDue).toBe(false);
  });
});

describe("Phase 9 — classifyWithConfidence", () => {
  test("skips reclassification when metrics confidence is MISSING or UNRELIABLE", () => {
    const missingRecord = {
      impressions: 0,
      performance_class: "baseline",
      metrics_confidence: METRICS_CONFIDENCE.MISSING,
    };

    const res = classifyWithConfidence(missingRecord);
    expect(res.skippedReason).toMatch(/unreliable_metrics_confidence/);
    expect(res.performanceClass).toBe("baseline");
  });

  test("classifies OUTSTANDING performance for high-impression fresh metrics", () => {
    const freshRecord = {
      impressions: 15000,
      likes: 450,
      replies: 40,
      metrics_confidence: METRICS_CONFIDENCE.FRESH,
    };

    const res = classifyWithConfidence(freshRecord);
    expect(res.skippedReason).toBeNull();
    expect(res.performanceClass).toBe("outstanding");
    expect(res.performanceScore).toBeGreaterThan(0.5);
  });
});

describe("Phase 9 — PatternMiner & Concept Extraction", () => {
  test("extracts concept features (hook type, technical depth, numbers)", () => {
    const reply = "foreign key indexes in sqlite cut p99 latency from 120ms to 15ms";
    const feat = extractConceptFeatures(reply);

    expect(feat.numbers_present).toBe(true);
    expect(feat.hook_type).toBe("data_point");
    expect(feat.technical_depth).toBeGreaterThan(0.5); // "sqlite", "latency", "p99"
  });

  test("mines conceptual takeaways distinguishing OUTSTANDING from BASELINE buckets", () => {
    const classifiedReplies = [
      {
        reply_text: "foreign key indexes in sqlite cut p99 latency from 120ms to 15ms",
        performance_class: "outstanding",
      },
      {
        reply_text: "redis caching reduced our postgres read load by 70%",
        performance_class: "outstanding",
      },
      {
        reply_text: "What do you think about database optimization? Thoughts?",
        performance_class: "baseline",
      },
      {
        reply_text: "Do you agree with this approach?",
        performance_class: "baseline",
      },
    ];

    const result = minePatterns(classifiedReplies);
    expect(result.sampleSize).toBe(4);
    expect(result.bucketStats.outstanding.dataPointRate).toBe(1.0);
    expect(result.bucketStats.baseline.questionRate).toBe(1.0);
    expect(result.conceptualInsights.length).toBeGreaterThan(0);
  });
});

describe("Phase 9 — Negative Pattern Extraction", () => {
  test("extracts failure tag distribution and creates avoidance directives", () => {
    const rejections = [
      { failure_tag: "GENERIC" },
      { failure_tag: "GENERIC" },
      { failure_tag: "FORCED_QUESTION" },
      { failure_tag: "UNSUPPORTED_CLAIM" },
    ];

    const neg = extractNegativePatterns(rejections);
    expect(neg.rejectionCount).toBe(4);
    expect(neg.failureTagDistribution.GENERIC).toBe(2);
    expect(neg.topAvoidanceDirectives).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Hollow affirmations"),
        expect.stringContaining("engagement-bait questions"),
      ])
    );
  });
});

describe("Phase 9 — proposeRankingWeightAdjustments", () => {
  test("generates normalized weight proposals with documented rationales without auto-mutating", () => {
    const miningResult = {
      sampleSize: 15,
      bucketStats: {
        outstanding: { count: 6, dataPointRate: 0.80, avgTechDepth: 0.70 },
        baseline:    { count: 6, dataPointRate: 0.10, avgTechDepth: 0.20 },
      },
    };

    const currentWeights = {
      semantic_similarity: 0.30,
      topic_similarity:    0.15,
      strategy_match:      0.15,
      performance_score:   0.20,
      voice_similarity:    0.10,
      recency_score:       0.05,
      novelty_score:       0.05,
    };

    const proposal = proposeRankingWeightAdjustments(miningResult, currentWeights);

    expect(proposal.id).toMatch(/^prop_/);
    expect(proposal.status).toBe("proposed");
    expect(proposal.rationale).toContain("performance_score");
    expect(proposal.proposed_weights.performance_score).toBeGreaterThan(currentWeights.performance_score);

    // Verify weights sum to 1.0
    const sum = Object.values(proposal.proposed_weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 2);
  });
});
