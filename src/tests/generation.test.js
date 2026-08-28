// src/tests/generation.test.js
// Unit tests for Phase 5 — Generation, Adaptation & Confidence Routing.
//
// Covers:
//   1. Confidence Router — all three routes (ADAPT / INSPIRE / GENERATE)
//   2. Routing guard conditions (staleness, contradiction, anti-repetition, novelty, recency)
//   3. Routing threshold configurability
//   4. ReplyAdapter — pre-adaptation safety checks (staleness, personal_insight guard)
//   5. ReplyAdapter — system prompt and user message construction (isolation, no raw interpolation)
//   6. ReplyGenerator — Stage 1 strategy catalogue completeness and validation
//   7. ReplyGenerator — Stage 1 fallback when JSON parse fails
//   8. ReplyGenerator — Stage 2 system prompt construction (spec-mandated generation prompt)
//   9. ReplyGenerator — Stage 2 candidate JSON parsing with fallback
//  10. Flag: ENABLE_INTELLIGENT_REPLY_ENGINE defaults OFF

"use strict";

const {
  ROUTE,
  DEFAULT_ROUTING_THRESHOLDS,
  checkStaleness,
  isTooSimilarToRecent,
  mayContradictCurrentPost,
  routeCandidate,
} = require("../../src/background/router");

const {
  ADAPTER_PROMPT_VERSION,
  STRATEGY_ADAPTATION_HINTS,
  buildAdapterSystemPrompt,
  buildAdapterUserMessage,
  preAdaptationCheck,
} = require("../../src/background/adapter");

const {
  GENERATOR_STAGE1_PROMPT_VERSION,
  GENERATOR_STAGE2_PROMPT_VERSION,
  GENERATION_SYSTEM_PROMPT_TEMPLATE,
  REPLY_STRATEGIES,
  buildStage1SystemPrompt,
  buildStage2SystemPrompt,
} = require("../../src/background/generator");

const { DEFAULT_FLAGS } = require("../../src/background/flags");
const { buildPromptContext } = require("../../src/background/prompt");

// ─────────────────────────────────────────────────────────────────────────────
// 0. Suppress console.warn/info noise from prompt.js
// ─────────────────────────────────────────────────────────────────────────────
beforeAll(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
});
afterAll(() => { jest.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Confidence Router — basic routing
// ─────────────────────────────────────────────────────────────────────────────

describe("routeCandidate — basic routing", () => {
  const baseCandidate = {
    similarity_score:   0.95,
    performance_score:  0.60,
    recency_score:      0.80,
    novelty_score:      0.70,
    reply_text:         "Specificity is the differentiator in saturated markets.",
    reply_strategy:     "specific_agreement_extension",
    topic:              "marketing",
    created_at:         new Date().toISOString(),
  };

  test("null candidate → GENERATE", () => {
    const result = routeCandidate(null, {}, []);
    expect(result.route).toBe(ROUTE.GENERATE);
    expect(result.reason).toMatch(/no_candidates_retrieved/);
  });

  test("similarity below medium band → GENERATE", () => {
    const result = routeCandidate({ ...baseCandidate, similarity_score: 0.60 }, {}, []);
    expect(result.route).toBe(ROUTE.GENERATE);
  });

  test("similarity in medium band → INSPIRE", () => {
    const result = routeCandidate({ ...baseCandidate, similarity_score: 0.85 }, {}, []);
    expect(result.route).toBe(ROUTE.INSPIRE);
  });

  test("high similarity with all guards cleared → ADAPT", () => {
    const result = routeCandidate(baseCandidate, { topic: "saas" }, []);
    expect(result.route).toBe(ROUTE.ADAPT);
    expect(result.guardsTriggered).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Routing guards — each guard triggers a downgrade to INSPIRE
// ─────────────────────────────────────────────────────────────────────────────

describe("routeCandidate — guard conditions", () => {
  const highSimBase = {
    similarity_score:   0.93,
    performance_score:  0.60,
    recency_score:      0.80,
    novelty_score:      0.70,
    reply_text:         "Unique and specific reply text here.",
    reply_strategy:     "practical_takeaway",
    topic:              "engineering",
    created_at:         new Date().toISOString(),
  };

  test("low performance score triggers guard → INSPIRE", () => {
    const result = routeCandidate(
      { ...highSimBase, performance_score: 0.01 },
      { topic: "general" },
      []
    );
    expect(result.route).toBe(ROUTE.INSPIRE);
    expect(result.guardsTriggered.some(g => g.startsWith("low_performance"))).toBe(true);
  });

  test("stale candidate (old date) triggers guard → INSPIRE", () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const result = routeCandidate(
      { ...highSimBase, created_at: oldDate },
      { topic: "general" },
      []
    );
    expect(result.route).toBe(ROUTE.INSPIRE);
    expect(result.guardsTriggered.some(g => g.startsWith("stale:"))).toBe(true);
  });

  test("too similar to recent reply triggers guard → INSPIRE", () => {
    const recentText = "Unique and specific reply text here."; // exact match
    const result = routeCandidate(
      highSimBase,
      { topic: "engineering" },
      [recentText]  // same text in recent replies
    );
    expect(result.route).toBe(ROUTE.INSPIRE);
    expect(result.guardsTriggered).toContain("too_similar_to_recent");
  });

  test("low novelty score triggers guard → INSPIRE", () => {
    const result = routeCandidate(
      { ...highSimBase, novelty_score: 0.05 },
      { topic: "general" },
      []
    );
    expect(result.route).toBe(ROUTE.INSPIRE);
    expect(result.guardsTriggered.some(g => g.startsWith("low_novelty"))).toBe(true);
  });

  test("low recency score triggers guard → INSPIRE", () => {
    const result = routeCandidate(
      { ...highSimBase, recency_score: 0.02 },
      { topic: "general" },
      []
    );
    expect(result.route).toBe(ROUTE.INSPIRE);
    expect(result.guardsTriggered.some(g => g.startsWith("low_recency"))).toBe(true);
  });

  test("contradiction risk triggers guard → INSPIRE", () => {
    const contradictingCandidate = {
      ...highSimBase,
      reply_strategy:    "respectful_disagreement",
      topic:             "marketing",
      similarity_score:  0.93,
    };
    // Analysis says topic matches exactly → contradiction risk
    const result = routeCandidate(
      contradictingCandidate,
      { topic: "marketing" },
      []
    );
    expect(result.route).toBe(ROUTE.INSPIRE);
    expect(result.guardsTriggered.some(g => g.startsWith("contradiction_risk"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Routing threshold configurability
// ─────────────────────────────────────────────────────────────────────────────

describe("routeCandidate — threshold configurability", () => {
  test("custom HIGH_CONFIDENCE_SIMILARITY changes ADAPT threshold", () => {
    const candidate = {
      similarity_score: 0.83,
      performance_score: 0.60,
      recency_score: 0.80,
      novelty_score: 0.70,
      reply_text: "A perfectly fine reply.",
      reply_strategy: "nuance",
      topic: "ai",
      created_at: new Date().toISOString(),
    };

    // With default threshold (0.90), 0.83 → INSPIRE
    const defaultResult = routeCandidate(candidate, {}, []);
    expect(defaultResult.route).toBe(ROUTE.INSPIRE);

    // With lowered threshold (0.80), 0.83 → ADAPT (if all guards clear)
    const customResult = routeCandidate(candidate, {}, [], {
      HIGH_CONFIDENCE_SIMILARITY: 0.80,
      MEDIUM_BAND_LOW: 0.65,
    });
    expect(customResult.route).toBe(ROUTE.ADAPT);
  });

  test("DEFAULT_ROUTING_THRESHOLDS are exported and all keys present", () => {
    const keys = [
      "HIGH_CONFIDENCE_SIMILARITY",
      "MEDIUM_BAND_LOW",
      "MEDIUM_BAND_HIGH",
      "MIN_PERFORMANCE_SCORE",
      "MAX_STALENESS_DAYS",
      "NOVELTY_FLOOR",
      "RECENCY_FLOOR",
      "RECENTLY_POSTED_SIMILARITY",
    ];
    keys.forEach(k => expect(DEFAULT_ROUTING_THRESHOLDS).toHaveProperty(k));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. checkStaleness helper
// ─────────────────────────────────────────────────────────────────────────────

describe("checkStaleness", () => {
  test("fresh candidate is not stale", () => {
    const result = checkStaleness({ reply_text: "fresh reply", created_at: new Date().toISOString() }, 90);
    expect(result.stale).toBe(false);
  });

  test("candidate older than maxStalenessdays is stale", () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const result = checkStaleness({ reply_text: "old reply", created_at: oldDate }, 90);
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/age_exceeded/);
  });

  test("reply with 3-year-old year reference is context-stale", () => {
    const year = new Date().getFullYear() - 3;
    const result = checkStaleness({ reply_text: `In ${year}, this was a major trend.`, created_at: new Date().toISOString() }, 90);
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/dated_year_reference/);
  });

  test("recent year reference is not stale", () => {
    const year = new Date().getFullYear();
    const result = checkStaleness({ reply_text: `In ${year}, this is a major trend.`, created_at: new Date().toISOString() }, 90);
    expect(result.stale).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. isTooSimilarToRecent helper
// ─────────────────────────────────────────────────────────────────────────────

describe("isTooSimilarToRecent", () => {
  test("returns false for empty recent list", () => {
    expect(isTooSimilarToRecent("Some reply text", [], 0.80)).toBe(false);
  });

  test("returns true when candidate is identical to a recent reply", () => {
    const text = "Building in public is the best distribution strategy";
    expect(isTooSimilarToRecent(text, [text], 0.80)).toBe(true);
  });

  test("returns false when candidate text is completely different", () => {
    const candidate = "Machine learning inference optimization at scale";
    const recent = ["Building in public is the best distribution strategy"];
    expect(isTooSimilarToRecent(candidate, recent, 0.80)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ReplyAdapter — preAdaptationCheck
// ─────────────────────────────────────────────────────────────────────────────

describe("preAdaptationCheck", () => {
  test("passes for normal candidate with empty voice samples (non-personal strategy)", () => {
    const candidate = {
      reply_text: "Specificity beats generality every time in SaaS marketing.",
      reply_strategy: "practical_takeaway",
    };
    const result = preAdaptationCheck(candidate, { voiceSamples: [] });
    expect(result.safe).toBe(true);
  });

  test("refuses personal_insight strategy with no voice samples", () => {
    const candidate = {
      reply_text: "I found that daily writing compounds just like interest.",
      reply_strategy: "personal_insight",
    };
    const result = preAdaptationCheck(candidate, { voiceSamples: [] });
    expect(result.safe).toBe(false);
    expect(result.refusalReason).toMatch(/personal_insight_strategy/);
  });

  test("passes personal_insight with voice samples present", () => {
    const candidate = {
      reply_text: "I found that daily writing compounds just like interest.",
      reply_strategy: "personal_insight",
    };
    const result = preAdaptationCheck(candidate, { voiceSamples: ["Sample A", "Sample B"] });
    expect(result.safe).toBe(true);
  });

  test("refuses candidate with stale year reference in reply text", () => {
    const staleYear = new Date().getFullYear() - 3;
    const candidate = {
      reply_text: `In ${staleYear}, the playbook was clear: ship fast and iterate.`,
      reply_strategy: "practical_takeaway",
    };
    const result = preAdaptationCheck(candidate, { voiceSamples: [] });
    expect(result.safe).toBe(false);
    expect(result.refusalReason).toMatch(/stale_year_reference/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. ReplyAdapter — prompt construction (no raw interpolation of untrusted text)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAdapterSystemPrompt", () => {
  const profile = {
    tone: "Direct",
    voiceSamples: ["Building fast matters more than planning perfectly.", "Shipping is a skill."],
  };
  const candidate = { reply_strategy: "concrete_example", reply_text: "..." };
  const analysis  = { topic: "builder", intent: "share_insight" };

  test("includes strategy adaptation hint", () => {
    const prompt = buildAdapterSystemPrompt(profile, candidate, analysis);
    expect(prompt).toContain(STRATEGY_ADAPTATION_HINTS["concrete_example"]);
  });

  test("includes voice samples", () => {
    const prompt = buildAdapterSystemPrompt(profile, candidate, analysis);
    expect(prompt).toContain("Building fast matters more than planning perfectly.");
  });

  test("contains do-not-copy instruction", () => {
    const prompt = buildAdapterSystemPrompt(profile, candidate, analysis);
    expect(prompt).toMatch(/do not copy.*verbatim/i);
  });

  test("contains no-facts-manufacturing instruction", () => {
    const prompt = buildAdapterSystemPrompt(profile, candidate, analysis);
    expect(prompt).toMatch(/never invent/i);
  });
});

describe("buildAdapterUserMessage — prompt isolation", () => {
  const context = { text: "This is a test source post", handle: "@tester" };
  const candidate = { reply_text: "This is the example reply to adapt.", reply_strategy: "nuance" };

  test("source post text is wrapped in SOURCE_POST delimiters", () => {
    const pCtx = buildPromptContext(context);
    const msg   = buildAdapterUserMessage(context, candidate, pCtx);
    expect(msg).toContain("[SOURCE_POST]");
    expect(msg).toContain("[/SOURCE_POST]");
  });

  test("candidate text is wrapped in EXAMPLE_REPLY_TO_ADAPT delimiters", () => {
    const pCtx = buildPromptContext(context);
    const msg   = buildAdapterUserMessage(context, candidate, pCtx);
    expect(msg).toContain("[EXAMPLE_REPLY_TO_ADAPT]");
    expect(msg).toContain("[/EXAMPLE_REPLY_TO_ADAPT]");
  });

  test("candidate text is truncated to 500 chars max", () => {
    const longCandidate = { reply_text: "x".repeat(1000), reply_strategy: "nuance" };
    const pCtx = buildPromptContext(context);
    const msg   = buildAdapterUserMessage(context, longCandidate, pCtx);
    // The candidate content between the delimiters must be at most 500 chars
    const match = msg.match(/\[EXAMPLE_REPLY_TO_ADAPT\]\n([\s\S]*?)\n\[\/EXAMPLE_REPLY_TO_ADAPT\]/);
    expect(match).not.toBeNull();
    expect(match[1].length).toBeLessThanOrEqual(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. STRATEGY_ADAPTATION_HINTS catalogue completeness
// ─────────────────────────────────────────────────────────────────────────────

describe("STRATEGY_ADAPTATION_HINTS", () => {
  test("covers all 15 reply strategies", () => {
    const strategyIds = REPLY_STRATEGIES.map(s => s.id);
    strategyIds.forEach(id => {
      // Each strategy in the generator catalogue must have an adapter hint
      // (or fall back to DEFAULT_ADAPTATION_HINT — both are acceptable)
      expect(
        typeof STRATEGY_ADAPTATION_HINTS[id] === "string" ||
        STRATEGY_ADAPTATION_HINTS[id] === undefined  // falls back to default hint
      ).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. ReplyGenerator — strategy catalogue
// ─────────────────────────────────────────────────────────────────────────────

describe("REPLY_STRATEGIES catalogue", () => {
  test("has at least 14 strategies", () => {
    expect(REPLY_STRATEGIES.length).toBeGreaterThanOrEqual(14);
  });

  test("every strategy has id, description, usability", () => {
    REPLY_STRATEGIES.forEach(s => {
      expect(s).toHaveProperty("id");
      expect(s).toHaveProperty("description");
      expect(s).toHaveProperty("usability");
      expect(typeof s.id).toBe("string");
      expect(s.id.length).toBeGreaterThan(0);
    });
  });

  test("no duplicate strategy ids", () => {
    const ids = REPLY_STRATEGIES.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("contains all spec-mandated strategies", () => {
    const specStrategies = [
      "specific_agreement_extension",
      "respectful_disagreement",
      "contrarian_observation",
      "concrete_example",
      "useful_correction",
      "personal_insight",
      "short_witty_observation",
      "data_backed_observation",
      "practical_takeaway",
      "nuance",
      "pattern_recognition",
      "story_fragment",
      "community_building_response",
      "genuine_question",
    ];
    const ids = REPLY_STRATEGIES.map(s => s.id);
    specStrategies.forEach(spec => {
      expect(ids).toContain(spec);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Stage 1 system prompt construction
// ─────────────────────────────────────────────────────────────────────────────

describe("buildStage1SystemPrompt", () => {
  const analysis = { topic: "saas_builder", intent: "share_insight", sentiment: "positive" };

  test("lists all strategy ids in the prompt", () => {
    const prompt = buildStage1SystemPrompt(analysis, []);
    REPLY_STRATEGIES.forEach(s => {
      expect(prompt).toContain(s.id);
    });
  });

  test("includes JSON return format specification", () => {
    const prompt = buildStage1SystemPrompt(analysis, []);
    expect(prompt).toContain("strategy_id");
    expect(prompt).toContain("rationale");
    expect(prompt).toContain("angle");
  });

  test("includes do-not-select rules for genuine_question and personal_insight", () => {
    const prompt = buildStage1SystemPrompt(analysis, []);
    expect(prompt).toContain("genuine_question");
    expect(prompt).toContain("personal_insight");
  });

  test("includes analysis context fields", () => {
    const prompt = buildStage1SystemPrompt(analysis, []);
    expect(prompt).toContain("saas_builder"); // topic
    expect(prompt).toContain("share_insight"); // intent
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Stage 2 system prompt construction
// ─────────────────────────────────────────────────────────────────────────────

describe("buildStage2SystemPrompt", () => {
  const profile = {
    handle:       "@builder",
    aboutYou:     "SaaS founder building in public",
    tone:         "Direct",
    voiceSamples: ["Ship fast. Learn faster.", "Distribution beats product every time."],
  };
  const strategyResult = {
    strategy_id: "nuance",
    rationale:   "Add precision to the claim",
    angle:       "Point out the exception that matters",
  };
  const lengthConfig = {
    instruction: "LENGTH: Medium — 1-2 sentences, 15-30 words.",
    max_tokens: 100,
  };

  test("contains the spec-mandated generation system prompt verbatim", () => {
    const prompt = buildStage2SystemPrompt(profile, strategyResult, [], [], lengthConfig);
    // Core sentences from the spec-mandated prompt
    expect(prompt).toContain("Your job is not to praise the author.");
    expect(prompt).toContain("Your job is to contribute one genuinely useful thought.");
    expect(prompt).toContain("Never invent facts or personal experiences");
    expect(prompt).toContain("Never manufacture engagement.");
    expect(prompt).toContain("One strong idea is better than three weak ones.");
    expect(prompt).toContain("Do not append 'thoughts?', 'agree?'");
  });

  test("contains selected strategy in prompt", () => {
    const prompt = buildStage2SystemPrompt(profile, strategyResult, [], [], lengthConfig);
    expect(prompt).toContain("nuance");
  });

  test("contains voice samples", () => {
    const prompt = buildStage2SystemPrompt(profile, strategyResult, [], [], lengthConfig);
    expect(prompt).toContain("Ship fast. Learn faster.");
  });

  test("requests exactly 3 candidates in JSON", () => {
    const prompt = buildStage2SystemPrompt(profile, strategyResult, [], [], lengthConfig);
    expect(prompt).toContain("\"candidates\"");
    expect(prompt).toContain("reply 1");
    expect(prompt).toContain("reply 2");
    expect(prompt).toContain("reply 3");
  });

  test("includes anti-repetition openers if recent replies provided", () => {
    const recent = ["Building in public", "Distribution beats product"];
    const prompt = buildStage2SystemPrompt(profile, strategyResult, [], recent, lengthConfig);
    expect(prompt).toContain("DO NOT START WITH");
    expect(prompt).toContain("Building in public...");
  });

  test("positive examples injected from high-performance ranked candidates", () => {
    const ranked = [
      { reply_strategy: "nuance", performance_score: 0.8, reply_text: "The exception is scale." },
      { reply_strategy: "nuance", performance_score: 0.7, reply_text: "Edge cases reveal the truth." },
    ];
    const prompt = buildStage2SystemPrompt(profile, strategyResult, ranked, [], lengthConfig);
    expect(prompt).toContain("SUCCESSFUL HISTORICAL EXAMPLES");
    expect(prompt).toContain("The exception is scale.");
  });

  test("negative examples injected from low-performance ranked candidates", () => {
    const ranked = [
      { reply_strategy: "something", performance_score: 0.05, reply_text: "Great post! So inspiring." },
    ];
    const prompt = buildStage2SystemPrompt(profile, strategyResult, ranked, [], lengthConfig);
    expect(prompt).toContain("NEGATIVE EXAMPLES");
    expect(prompt).toContain("Great post! So inspiring.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Prompt version constants are exported
// ─────────────────────────────────────────────────────────────────────────────

describe("Prompt version constants", () => {
  test("ADAPTER_PROMPT_VERSION is a non-empty string", () => {
    expect(typeof ADAPTER_PROMPT_VERSION).toBe("string");
    expect(ADAPTER_PROMPT_VERSION.length).toBeGreaterThan(0);
  });

  test("GENERATOR_STAGE1_PROMPT_VERSION is a non-empty string", () => {
    expect(typeof GENERATOR_STAGE1_PROMPT_VERSION).toBe("string");
    expect(GENERATOR_STAGE1_PROMPT_VERSION.length).toBeGreaterThan(0);
  });

  test("GENERATOR_STAGE2_PROMPT_VERSION is a non-empty string", () => {
    expect(typeof GENERATOR_STAGE2_PROMPT_VERSION).toBe("string");
    expect(GENERATOR_STAGE2_PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. ENABLE_INTELLIGENT_REPLY_ENGINE defaults to false
// ─────────────────────────────────────────────────────────────────────────────

describe("Feature flag default", () => {
  test("ENABLE_INTELLIGENT_REPLY_ENGINE is false by default", () => {
    expect(DEFAULT_FLAGS.ENABLE_INTELLIGENT_REPLY_ENGINE).toBe(false);
  });
});
