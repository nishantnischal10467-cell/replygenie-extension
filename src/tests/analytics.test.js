// src/tests/analytics.test.js
// Unit tests for Phase 10 — Analytics Dashboard Data Layer.
//
// Covers:
//   1. Statistical helpers (calculateMedian, calculateMean)
//   2. Generation mix rates (reuse, adaptation, AI gen, human written)
//   3. Impressions distribution & performance class counts
//   4. Engagement, author reply rate, and profile visit rate
//   5. Question rate and behavioral metrics
//   6. Rejection rates by failure taxonomy (genericity, accuracy, duplicates)
//   7. Qualified Conversation Rate (QCR) calculation & separation from raw impressions
//   8. Rankings & breakdowns (top/worst 20 replies, top/worst strategies & topics)
//   9. queryFullAnalyticsSuite integration

"use strict";

const {
  ANALYTICS_MODULE_VERSION,
  calculateMedian,
  calculateMean,
  aggregateDashboardMetrics,
  computeRankingsAndBreakdowns,
  queryFullAnalyticsSuite,
} = require("../../src/background/analytics");

describe("Phase 10 — Statistical Helpers", () => {
  test("calculates median accurately for odd and even arrays", () => {
    expect(calculateMedian([10, 50, 100])).toBe(50);
    expect(calculateMedian([10, 40, 60, 100])).toBe(50);
    expect(calculateMedian([])).toBe(0);
    expect(calculateMedian([42])).toBe(42);
  });

  test("calculates mean accurately", () => {
    expect(calculateMean([10, 20, 30])).toBe(20);
    expect(calculateMean([10, 15, 20])).toBe(15);
    expect(calculateMean([])).toBe(0);
  });
});

describe("Phase 10 — aggregateDashboardMetrics", () => {
  const sampleReplies = [
    {
      id: "r1",
      reply_text: "foreign key indexes in sqlite cut p99 latency by 80%",
      is_ai_generated: 1,
      is_adapted: 0,
      is_reused: 0,
      is_human_written: 0,
      impressions: 12000,
      likes: 250,
      replies: 18,
      reposts: 12,
      bookmarks: 35,
      author_replied: 1,
      profile_visits: 45,
      performance_class: "outstanding",
      meaningful_user_replies: 10,
      attributable_follows: 8,
    },
    {
      id: "r2",
      reply_text: "redis caching reduced our postgres read load",
      is_ai_generated: 0,
      is_adapted: 1,
      is_reused: 0,
      is_human_written: 0,
      impressions: 1500,
      likes: 45,
      replies: 4,
      reposts: 2,
      bookmarks: 5,
      author_replied: 0,
      profile_visits: 12,
      performance_class: "moderate",
      meaningful_user_replies: 2,
      attributable_follows: 1,
    },
    {
      id: "r3",
      reply_text: "What do you think about postgres? Thoughts?",
      is_ai_generated: 0,
      is_adapted: 0,
      is_reused: 1,
      is_human_written: 0,
      impressions: 300,
      likes: 2,
      replies: 1,
      reposts: 0,
      bookmarks: 0,
      author_replied: 0,
      profile_visits: 1,
      performance_class: "baseline",
      meaningful_user_replies: 0,
      attributable_follows: 0,
    },
    {
      id: "r4",
      reply_text: "wrote this directly on twitter feed",
      is_ai_generated: 0,
      is_adapted: 0,
      is_reused: 0,
      is_human_written: 1,
      impressions: 800,
      likes: 15,
      replies: 2,
      reposts: 1,
      bookmarks: 2,
      author_replied: 1,
      profile_visits: 4,
      performance_class: "baseline",
      meaningful_user_replies: 1,
      attributable_follows: 0,
    },
  ];

  const sampleRejections = [
    { failure_tag: "GENERIC" },
    { failure_tag: "GENERIC" },
    { failure_tag: "UNSUPPORTED_CLAIM" },
    { failure_tag: "REPETITIVE" },
  ];

  test("computes generation mix rates correctly", () => {
    const metrics = aggregateDashboardMetrics(sampleReplies, sampleRejections, []);
    const mix = metrics.generation_mix;

    expect(mix.total_replies).toBe(4);
    expect(mix.ai_generation_rate).toBe(0.25);
    expect(mix.database_adaptation_rate).toBe(0.25);
    expect(mix.database_reuse_rate).toBe(0.25);
    expect(mix.human_written_rate).toBe(0.25);
  });

  test("computes impressions distribution and performance classes", () => {
    const metrics = aggregateDashboardMetrics(sampleReplies, sampleRejections, []);
    const imp = metrics.impressions;

    expect(imp.total).toBe(14600);
    expect(imp.average).toBe(3650);
    expect(imp.median).toBe(1150); // (800 + 1500)/2 = 1150
    expect(imp.outstanding_count).toBe(1);
    expect(imp.moderate_count).toBe(1);
    expect(imp.baseline_count).toBe(2);
  });

  test("computes engagement and question rates", () => {
    const metrics = aggregateDashboardMetrics(sampleReplies, sampleRejections, []);

    // Total engagements: (250+18+12+35) + (45+4+2+5) + (2+1+0+0) + (15+2+1+2) = 315 + 56 + 3 + 20 = 394
    // Engagement rate = 394 / 14600 = ~0.0270
    expect(metrics.engagement.total_engagements).toBe(394);
    expect(metrics.engagement.average_engagement_rate).toBeCloseTo(0.0270, 3);
    expect(metrics.engagement.author_reply_rate).toBe(0.5); // 2 out of 4
    expect(metrics.behavioral.question_rate).toBe(0.25); // 1 out of 4 (r3)
  });

  test("computes quality gate rejection rates by failure taxonomy", () => {
    const metrics = aggregateDashboardMetrics(sampleReplies, sampleRejections, []);
    const qg = metrics.quality_gate;

    expect(qg.total_rejections_recorded).toBe(4);
    // Total evaluated = 4 replies + 4 rejections = 8
    expect(qg.genericity_rejection_rate).toBe(2 / 8); // 0.25
    expect(qg.accuracy_rejection_rate).toBe(1 / 8);   // 0.125
    expect(qg.duplicate_rejection_rate).toBe(1 / 8);  // 0.125
  });

  test("computes Qualified Conversation Rate (QCR) separately from raw impressions", () => {
    const metrics = aggregateDashboardMetrics(sampleReplies, sampleRejections, []);
    const qcr = metrics.qualified_conversation;

    // author_replies: 2
    // meaningful_user_replies: 10 + 2 + 0 + 1 = 13
    // profile_visits: 45 + 12 + 1 + 4 = 62
    // attributable_follows: 8 + 1 + 0 + 0 = 9
    // Total qualified events = 2 + 13 + 62 + 9 = 86
    // QCR = 86 / 14600 = ~0.0059
    expect(qcr.author_replies).toBe(2);
    expect(qcr.meaningful_user_replies).toBe(13);
    expect(qcr.profile_visits).toBe(62);
    expect(qcr.attributable_follows).toBe(9);
    expect(qcr.total_qualified_events).toBe(86);
    expect(qcr.qualified_conversation_rate).toBeCloseTo(0.0059, 4);
    expect(qcr.formula).toContain("total_impressions");
  });
});

describe("Phase 10 — computeRankingsAndBreakdowns", () => {
  const rankedReplies = [
    { id: "r1", reply_text: "Top reply 1", performance_score: 0.95, impressions: 20000, reply_strategy: "contrarian_take", topic: "engineering" },
    { id: "r2", reply_text: "Top reply 2", performance_score: 0.85, impressions: 15000, reply_strategy: "contrarian_take", topic: "engineering" },
    { id: "r3", reply_text: "Mid reply",   performance_score: 0.50, impressions: 3000,  reply_strategy: "data_point",      topic: "saas" },
    { id: "r4", reply_text: "Worst reply", performance_score: 0.10, impressions: 100,   reply_strategy: "question",        topic: "general" },
  ];

  const samplePatterns = [
    { pattern_id: "p1", strategy: "contrarian_take", engagement_rate: 0.08, impressions: 12000 },
    { pattern_id: "p2", strategy: "data_point",      engagement_rate: 0.05, impressions: 5000 },
  ];

  test("ranks top and worst 20 replies correctly", () => {
    const rankings = computeRankingsAndBreakdowns(rankedReplies, samplePatterns);

    expect(rankings.top_20_replies[0].id).toBe("r1");
    expect(rankings.top_20_replies[1].id).toBe("r2");
    expect(rankings.worst_20_replies[0].id).toBe("r4");
    expect(rankings.top_20_patterns[0].pattern_id).toBe("p1");
  });

  test("computes top and worst strategies and topics", () => {
    const rankings = computeRankingsAndBreakdowns(rankedReplies, samplePatterns);

    expect(rankings.top_strategies[0].strategy).toBe("contrarian_take");
    expect(rankings.worst_strategies[0].strategy).toBe("question");
    expect(rankings.top_topics[0].topic).toBe("engineering");
    expect(rankings.worst_topics[0].topic).toBe("general");
  });
});

describe("Phase 10 — queryFullAnalyticsSuite", () => {
  test("loads data and returns structured metrics and rankings", async () => {
    const mockDb = {
      repliesRepo: {
        getRecentReplies: async () => [
          { id: "r1", reply_text: "sample", performance_score: 0.9, impressions: 1000, is_ai_generated: 1, performance_class: "outstanding" },
        ],
      },
      replyPatternsRepo: {
        getPatternsByStrategy: async () => [
          { pattern_id: "p1", strategy: "default", engagement_rate: 0.05 },
        ],
      },
    };

    const result = await queryFullAnalyticsSuite(mockDb);
    expect(result.metrics).toBeDefined();
    expect(result.metrics.generation_mix.total_replies).toBe(1);
    expect(result.rankings).toBeDefined();
    expect(result.rankings.top_20_replies.length).toBe(1);
  });
});
