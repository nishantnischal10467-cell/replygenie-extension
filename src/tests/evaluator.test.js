// src/tests/evaluator.test.js
// Unit tests for Phase 6 — Quality / Accuracy / Genericity Gate.
//
// Covers:
//   1. Failure taxonomy completeness (all 16 required failure tags)
//   2. Composite score calculation with default weights
//   3. Hard rejection thresholds (accuracy < 8, relevance < 8, genericity > 4)
//   4. Genericity heuristic — literal spec examples ("Great insights here...", "Couldn't agree more...", etc.)
//   5. Forced-question detection — literal banned endings list from spec ("Thoughts?", "Agree?", "Right?", etc.)
//   6. Claim extraction and AccuracyChecker (stats, hallucinated numbers, unverified personal experiences)
//   7. DuplicateDetector — cosine BoW + n-gram similarity
//   8. Repeated structure detection (COPIED_STRUCTURE)
//   9. Heuristic screening (fast multi-rule rejection)
//  10. Full evaluateCandidates orchestration (pass, retry with failure feedback, queue for human review)

"use strict";

const {
  FAILURE_TAGS,
  DEFAULT_EVAL_WEIGHTS,
  DEFAULT_REJECTION_THRESHOLDS,
  FORCED_QUESTION_ENDINGS,
  GENERIC_PHRASES,
  detectForcedQuestion,
  computeGenericityScore,
  extractClaims,
  checkClaimSupport,
  checkAccuracy,
  ngramJaccard,
  bowCosine,
  detectDuplicate,
  detectRepeatedStructure,
  heuristicScreen,
  computeCompositeScore,
  evaluateCandidates,
  EVALUATOR_SYSTEM_PROMPT,
  HUMAN_REVIEW_QUEUE_KEY,
} = require("../../src/background/evaluator");

beforeAll(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
});
afterAll(() => { jest.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Failure Taxonomy Completeness
// ─────────────────────────────────────────────────────────────────────────────

describe("FAILURE_TAGS taxonomy completeness", () => {
  const expectedTags = [
    "GENERIC",
    "TOO_LONG",
    "TOO_SHORT",
    "REPETITIVE",
    "OBVIOUS_AI",
    "LOW_RELEVANCE",
    "NO_NEW_VALUE",
    "UNSUPPORTED_CLAIM",
    "FORCED_QUESTION",
    "TOO_PROMOTIONAL",
    "TOO_AGREEABLE",
    "OVERLY_FORMAL",
    "OFF_TOPIC",
    "WEAK_HOOK",
    "COPIED_STRUCTURE",
    "LOW_CONVERSATIONAL_VALUE",
  ];

  test("contains all 16 required failure taxonomy tags", () => {
    expectedTags.forEach((tag) => {
      expect(FAILURE_TAGS).toHaveProperty(tag, tag);
    });
  });

  test("no undefined or empty tag values", () => {
    Object.values(FAILURE_TAGS).forEach((val) => {
      expect(typeof val).toBe("string");
      expect(val.length).toBeGreaterThan(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Composite Score Formula & Default Weights
// ─────────────────────────────────────────────────────────────────────────────

describe("computeCompositeScore & Weights", () => {
  test("default weights match spec formula and sum to 1.0 (positive weights)", () => {
    const positiveSum =
      DEFAULT_EVAL_WEIGHTS.relevance +
      DEFAULT_EVAL_WEIGHTS.specificity +
      DEFAULT_EVAL_WEIGHTS.originality +
      DEFAULT_EVAL_WEIGHTS.human_likeness +
      DEFAULT_EVAL_WEIGHTS.accuracy +
      DEFAULT_EVAL_WEIGHTS.voice_match +
      DEFAULT_EVAL_WEIGHTS.conversation_value;

    expect(positiveSum).toBeCloseTo(1.0, 4);
    expect(DEFAULT_EVAL_WEIGHTS.genericity_penalty_weight).toBe(0.10);
  });

  test("computes exact composite score for given scores", () => {
    const scores = {
      relevance: 10,
      specificity: 8,
      originality: 8,
      human_likeness: 8,
      accuracy: 10,
      voice_match: 8,
      conversation_value: 8,
      genericity: 2, // 2 * 0.10 penalty = 0.20
    };
    // 10*0.20 + 8*0.15 + 8*0.15 + 8*0.15 + 10*0.15 + 8*0.10 + 8*0.10 - 2*0.10
    // = 2.0 + 1.2 + 1.2 + 1.2 + 1.5 + 0.8 + 0.8 - 0.2 = 8.5
    const result = computeCompositeScore(scores);
    expect(result.composite).toBeCloseTo(8.5, 2);
    expect(result.hardRejectReason).toBeNull();
  });

  test("genericity penalty properly deducts from composite score", () => {
    const baseScores = {
      relevance: 9,
      specificity: 8,
      originality: 8,
      human_likeness: 8,
      accuracy: 9,
      voice_match: 8,
      conversation_value: 8,
      genericity: 0,
    };
    const zeroGen = computeCompositeScore(baseScores);
    const highGen = computeCompositeScore({ ...baseScores, genericity: 4 });
    expect(zeroGen.composite - highGen.composite).toBeCloseTo(0.40, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Hard Rejection Gates
// ─────────────────────────────────────────────────────────────────────────────

describe("Hard Rejection Thresholds", () => {
  const goodScores = {
    relevance: 9,
    specificity: 8,
    originality: 8,
    human_likeness: 8,
    accuracy: 9,
    voice_match: 8,
    conversation_value: 8,
    genericity: 2,
  };

  test("accuracy < 8 triggers hard rejection", () => {
    const result = computeCompositeScore({ ...goodScores, accuracy: 7 });
    expect(result.hardRejectReason).toMatch(/accuracy_below_minimum/);
  });

  test("accuracy >= 8 passes accuracy threshold", () => {
    const result = computeCompositeScore({ ...goodScores, accuracy: 8 });
    expect(result.hardRejectReason).toBeNull();
  });

  test("relevance < 8 triggers hard rejection", () => {
    const result = computeCompositeScore({ ...goodScores, relevance: 7 });
    expect(result.hardRejectReason).toMatch(/relevance_below_minimum/);
  });

  test("relevance >= 8 passes relevance threshold", () => {
    const result = computeCompositeScore({ ...goodScores, relevance: 8 });
    expect(result.hardRejectReason).toBeNull();
  });

  test("genericity > 4 triggers hard rejection", () => {
    const result = computeCompositeScore({ ...goodScores, genericity: 5 });
    expect(result.hardRejectReason).toMatch(/genericity_above_maximum/);
  });

  test("genericity <= 4 passes genericity threshold", () => {
    const result = computeCompositeScore({ ...goodScores, genericity: 4 });
    expect(result.hardRejectReason).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Genericity Test — Literal Spec Examples
// ─────────────────────────────────────────────────────────────────────────────

describe("computeGenericityScore — spec examples", () => {
  test("literal spec rejects get high genericity scores (> 4)", () => {
    const specRejects = [
      "Great insights here, thanks for sharing!",
      "Couldn't agree more with this perspective.",
      "100% so true, well said!",
      "Love this. Such a great point.",
      "This is gold! Absolute gold.",
      "So true! Needed to hear this today 🙌",
    ];

    specRejects.forEach((reply) => {
      const { score, signals } = computeGenericityScore(reply);
      expect(score).toBeGreaterThan(4);
      expect(signals.length).toBeGreaterThan(0);
    });
  });

  test("specific, substantive replies score low on genericity (<= 4)", () => {
    const goodReplies = [
      "The 85% drop in memory usage after the Rust rewrite matches what we saw when switching our Redis cache.",
      "Modular monoliths work well until your team crosses 15 engineers, then boundary contention starts.",
      "If you're tracking LTV/CAC ratio monthly, the latency in cohort maturation will skew the first 90 days.",
    ];

    goodReplies.forEach((reply) => {
      const { score } = computeGenericityScore(reply);
      expect(score).toBeLessThanOrEqual(4);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Forced-Question Detection
// ─────────────────────────────────────────────────────────────────────────────

describe("detectForcedQuestion — spec banned endings", () => {
  test("detects literal spec engagement-bait endings", () => {
    const baitSamples = [
      "Good point on distribution. Thoughts?",
      "We saw this in our stack too. What do you think?",
      "Caching is the hardest part. Agree?",
      "You have to start somewhere. Right?",
      "Consistency beats intensity. Does this resonate?",
      "This is how SaaS compounds. Would you agree?",
      "Hard work always wins. Am I wrong?",
      "Great milestone. Who else?",
      "Interesting perspective. Any thoughts?",
      "We do this every sprint. Let me know in the comments!",
    ];

    baitSamples.forEach((reply) => {
      const { forced } = detectForcedQuestion(reply, "Some source post text");
      expect(forced).toBe(true);
    });
  });

  test("exempts substantive questions that reference specific source content", () => {
    const sourceText = "We migrated our PostgreSQL database to SQLite for local development.";
    const substantiveReply = "Did the SQLite migration affect your foreign key constraints during local testing?";
    
    const { forced } = detectForcedQuestion(substantiveReply, sourceText);
    expect(forced).toBe(false);
  });

  test("passes non-question statements", () => {
    const nonQuestion = "Foreign key handling in SQLite requires PRAGMA foreign_keys = ON at connection time.";
    const { forced } = detectForcedQuestion(nonQuestion, "Some source post text");
    expect(forced).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Claim Extraction & AccuracyChecker
// ─────────────────────────────────────────────────────────────────────────────

describe("AccuracyChecker & Claim Verification", () => {
  test("extracts numbers, personal experience, and entity assertions", () => {
    const text = "We achieved 45% lower latency when I built our caching layer with Redis.";
    const claims = extractClaims(text);
    expect(claims.length).toBeGreaterThan(0);
  });

  test("rejects hallucinated statistics not present in source or verified context", () => {
    const verifiedContext = {
      sourceText: "We improved our search performance significantly.",
      candidateTexts: [],
      voiceSamples: [],
    };
    const replyWithFakeStat = "We achieved a 99.8% reduction in latency across 50,000 requests.";
    const result = checkAccuracy(replyWithFakeStat, verifiedContext);
    expect(result.unsupportedClaim).not.toBeNull();
    expect(result.reason).toMatch(/number_not_in_verified_context/);
  });

  test("passes verified statistics present in the source text", () => {
    const verifiedContext = {
      sourceText: "Our API latency dropped from 200ms to 45ms (a 77% drop).",
      candidateTexts: [],
      voiceSamples: [],
    };
    const replyWithSourceStat = "A 77% drop to 45ms is huge for user retention.";
    const result = checkAccuracy(replyWithSourceStat, verifiedContext);
    expect(result.unsupportedClaim).toBeNull();
  });

  test("rejects personal experience claims when voice samples do not verify the experience", () => {
    const verifiedContext = {
      sourceText: "SaaS churn is hard to fix.",
      candidateTexts: [],
      voiceSamples: ["I focus heavily on frontend performance."], // No churn experience mentioned
    };
    const replyWithUnverifiedExperience = "When I built our churn prediction engine, we found email outreach worked best.";
    const result = checkAccuracy(replyWithUnverifiedExperience, verifiedContext);
    expect(result.unsupportedClaim).not.toBeNull();
    expect(result.reason).toMatch(/personal_claim_not_in_voice_samples/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Duplicate Detection (Cosine + N-gram)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectDuplicate", () => {
  test("detects duplicate when cosine and ngram both exceed thresholds", () => {
    const existing = ["Building in public is the best distribution strategy for indie hackers"];
    const candidate = "Building in public is the best distribution strategy for indie hackers.";
    const result = detectDuplicate(candidate, existing);
    expect(result.duplicate).toBe(true);
  });

  test("passes when text is semantically and structurally distinct", () => {
    const existing = ["Building in public is the best distribution strategy for indie hackers"];
    const candidate = "Profiling memory leaks in Node.js requires inspecting heap snapshots.";
    const result = detectDuplicate(candidate, existing);
    expect(result.duplicate).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Repeated Structure Detection (COPIED_STRUCTURE)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectRepeatedStructure", () => {
  test("flags repeated opener structures across recent replies", () => {
    const recent = [
      "The hardest part is getting started",
      "The hardest part is staying consistent",
      "The hardest part is managing state",
    ];
    const candidate = "The hardest part is scaling to 100k users";
    const result = detectRepeatedStructure(candidate, recent, 5, 2);
    expect(result.repeated).toBe(true);
    expect(result.matchCount).toBeGreaterThanOrEqual(2);
  });

  test("passes when candidate uses a fresh structural opener", () => {
    const recent = [
      "The hardest part is getting started",
      "The hardest part is staying consistent",
    ];
    const candidate = "Memory management in WebAssembly is surprisingly straightforward";
    const result = detectRepeatedStructure(candidate, recent, 5, 2);
    expect(result.repeated).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Heuristic Screening
// ─────────────────────────────────────────────────────────────────────────────

describe("heuristicScreen", () => {
  test("tags TOO_SHORT for replies with < 3 words", () => {
    const screen = heuristicScreen("Great point!", "", [], {});
    expect(screen.failureTags).toContain(FAILURE_TAGS.TOO_SHORT);
  });

  test("tags GENERIC and FORCED_QUESTION when applicable", () => {
    const screen = heuristicScreen("Great insights here! Thoughts?", "", [], {});
    expect(screen.failureTags).toContain(FAILURE_TAGS.GENERIC);
    expect(screen.failureTags).toContain(FAILURE_TAGS.FORCED_QUESTION);
  });

  test("passes high quality candidate with empty failure tags", () => {
    const screen = heuristicScreen(
      "Measuring p99 latency during traffic spikes gives a much clearer picture than mean averages.",
      "How do you measure API latency under load?",
      [],
      {}
    );
    expect(screen.failureTags).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Full evaluateCandidates Orchestration
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluateCandidates Orchestrator", () => {
  const mockProfile = {
    tone: "Direct",
    voiceSamples: ["Performance is our primary metric."],
  };
  const mockContext = { text: "We optimized our SQL queries." };

  test("selects passing candidate on first pass without regeneration", async () => {
    const candidates = [
      { text: "Great insights! Thoughts?" }, // Fails generic + forced question
      { text: "Adding composite indexes on frequently filtered foreign keys cut our query times by half." }, // Passes
      { text: "Cool." }, // Fails too short
    ];

    const result = await evaluateCandidates(
      candidates,
      mockContext,
      mockProfile,
      [],
      { sourceText: mockContext.text },
      { apiKey: "test-key" },
      () => ({ userBlock: "test", systemPreamble: "test" }),
      null // No regenerateFn needed
    );

    expect(result.regenerated).toBe(false);
    expect(result.queuedForReview).toBe(false);
    expect(result.text).toContain("composite indexes");
  });

  test("triggers regeneration once when all 3 candidates fail first pass", async () => {
    const failingCandidates = [
      { text: "Great insights! Thoughts?" },
      { text: "100% agreed! What do you think?" },
      { text: "Nice." },
    ];

    const regeneratedCandidates = [
      { text: "Explain plans often reveal sequential scans that indexing immediately fixes." },
    ];

    let regenCalledWith = null;
    const mockRegenerateFn = async (reasons) => {
      regenCalledWith = reasons;
      return { candidates: regeneratedCandidates };
    };

    const result = await evaluateCandidates(
      failingCandidates,
      mockContext,
      mockProfile,
      [],
      { sourceText: mockContext.text },
      { apiKey: "test-key" },
      () => ({ userBlock: "test", systemPreamble: "test" }),
      mockRegenerateFn
    );

    expect(result.regenerated).toBe(true);
    expect(result.queuedForReview).toBe(false);
    expect(result.text).toContain("Explain plans");
    expect(regenCalledWith).toContain(FAILURE_TAGS.GENERIC);
    expect(regenCalledWith).toContain(FAILURE_TAGS.FORCED_QUESTION);
  });
});
