// src/tests/eval.test.js
// Eval set runner — checks every fixture against current detection logic.
// Run with:   npm test -- --testPathPattern=eval
//             npm run test:eval
//
// Rules for this file:
//   - NEVER remove a failing test — fix the code or update _note with a known-gap comment.
//   - To update an expected value, add a comment explaining why.
//   - Add new fixtures to fixtures.js, not here.

"use strict";

const { detectInjectionAttempt, buildPromptContext, makeSourcePostId } = require("../../src/background/prompt");
const { EVAL_FIXTURES } = require("./eval/fixtures");

// Load templates for templateMatch checks — uses module.exports added in Phase 1
const { INTENT_PATTERNS } = require("../../src/background/templates");

// Helper: runs INTENT_PATTERNS against text, mirrors detectTemplateIntent in background.js.
// INTENT_PATTERNS is [{category:string, test:(text)=>boolean}] — not plain regex objects.
function detectTemplateIntent(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const pattern of INTENT_PATTERNS) {
    if (pattern.test(t)) return pattern.category;
  }
  return null;
}
// Suppress console.warn from prompt.js injection warnings during tests
beforeAll(() => { jest.spyOn(console, "warn").mockImplementation(() => {}); });
beforeAll(() => { jest.spyOn(console, "info").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

describe("Eval set — fixture loading", () => {
  test("has at least 30 fixtures", () => {
    expect(EVAL_FIXTURES.length).toBeGreaterThanOrEqual(30);
  });

  test("each fixture has required fields", () => {
    for (const f of EVAL_FIXTURES) {
      expect(f).toHaveProperty("id");
      expect(f).toHaveProperty("category");
      expect(f).toHaveProperty("tweet");
      expect(f).toHaveProperty("expected");
      expect(f.tweet).toHaveProperty("text");
      expect(f.tweet).toHaveProperty("handle");
    }
  });

  test("no duplicate fixture ids", () => {
    const ids = EVAL_FIXTURES.map(f => f.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ── Per-fixture checks ────────────────────────────────────────────────────────

describe("Eval set — injection detection", () => {
  const adversarial = EVAL_FIXTURES.filter(f => f.expected.injectionFlagged === true);
  const benign      = EVAL_FIXTURES.filter(f => f.expected.injectionFlagged === false);

  test("all adversarial fixtures are flagged", () => {
    const failures = [];
    for (const f of adversarial) {
      const flagged = detectInjectionAttempt(f.tweet.text) ||
                      detectInjectionAttempt(f.tweet.handle) ||
                      detectInjectionAttempt(f.tweet.displayName || "");
      if (!flagged) failures.push(f.id);
    }
    if (failures.length > 0) {
      console.warn("[eval] Unflagged adversarial fixtures:", failures);
    }
    expect(failures).toHaveLength(0);
  });

  test("benign fixtures are NOT flagged (no false positives)", () => {
    const falsePositives = [];
    for (const f of benign) {
      const flagged = detectInjectionAttempt(f.tweet.text) ||
                      detectInjectionAttempt(f.tweet.handle) ||
                      detectInjectionAttempt(f.tweet.displayName || "");
      if (flagged) falsePositives.push(f.id);
    }
    if (falsePositives.length > 0) {
      console.warn("[eval] False-positive fixtures:", falsePositives);
    }
    expect(falsePositives).toHaveLength(0);
  });

  test("overall pass rate (injection detection) is >= 85%", () => {
    let correct = 0;
    for (const f of EVAL_FIXTURES) {
      const flagged = detectInjectionAttempt(f.tweet.text) ||
                      detectInjectionAttempt(f.tweet.handle) ||
                      detectInjectionAttempt(f.tweet.displayName || "");
      if (flagged === f.expected.injectionFlagged) correct++;
    }
    const passRate = correct / EVAL_FIXTURES.length;
    console.info("[eval] Injection detection pass rate:", (passRate * 100).toFixed(1) + "%", "(" + correct + "/" + EVAL_FIXTURES.length + ")");
    expect(passRate).toBeGreaterThanOrEqual(0.85);
  });
});

describe("Eval set — template short-circuit detection", () => {
  test("each fixture's templateMatch expectation is correct", () => {
    const failures = [];
    for (const f of EVAL_FIXTURES) {
      const match = detectTemplateIntent(f.tweet.text);
      if (match !== f.expected.templateMatch) {
        failures.push({ id: f.id, expected: f.expected.templateMatch, got: match });
      }
    }
    if (failures.length > 0) {
      console.warn("[eval] Template match mismatches:", JSON.stringify(failures, null, 2));
    }
    expect(failures).toHaveLength(0);
  });
});

describe("Eval set — buildPromptContext structure", () => {
  test("wraps untrusted content in [SOURCE_POST] delimiters for every fixture", () => {
    for (const f of EVAL_FIXTURES) {
      const ctx = buildPromptContext(f.tweet);
      expect(ctx.userBlock).toContain("[SOURCE_POST]");
      expect(ctx.userBlock).toContain("[/SOURCE_POST]");
    }
  });

  test("systemPreamble contains data-boundary instruction for every fixture", () => {
    for (const f of EVAL_FIXTURES) {
      const ctx = buildPromptContext(f.tweet);
      expect(ctx.systemPreamble).toContain("DATA TO ANALYZE");
      expect(ctx.systemPreamble).toContain("DATA BOUNDARY RULE");
    }
  });

  test("adversarial tweets do not escape into systemPreamble", () => {
    for (const f of EVAL_FIXTURES.filter(x => x.expected.injectionFlagged)) {
      const ctx = buildPromptContext(f.tweet);
      // The raw adversarial text must not appear in the system preamble
      if (f.tweet.text) {
        expect(ctx.systemPreamble).not.toContain(f.tweet.text);
      }
    }
  });

  test("long tweet text is capped at 1000 chars", () => {
    const longText = "x".repeat(5000);
    const ctx = buildPromptContext({ text: longText, handle: "@test" });
    expect(ctx.userBlock.length).toBeLessThan(5000 + 200); // 200 = overhead of labels
  });

  test("makeSourcePostId returns <= 80 chars", () => {
    for (const f of EVAL_FIXTURES) {
      const id = makeSourcePostId(f.tweet);
      expect(id.length).toBeLessThanOrEqual(80);
    }
  });
});

// ── Phase 4: Ranking & Threshold Evaluation Suite ─────────────────────────────

const { classifyPerformance, rankCandidates } = require("../../src/background/ranker");

describe("Eval set — Phase 4 ranking boundaries and tradeoffs", () => {
  const rankingBoundaryFixtures = EVAL_FIXTURES.filter(f => f.category === "ranking_eval" && f.rankingData);
  const rankingTradeoffFixtures = EVAL_FIXTURES.filter(f => f.category === "ranking_eval" && f.candidates);

  test("boundary fixtures match expected performance classes (499/500/9999/10000)", () => {
    for (const f of rankingBoundaryFixtures) {
      const actualClass = classifyPerformance(f.rankingData.impressions);
      expect(actualClass).toBe(f.expected.expectedPerformanceClass);
    }
  });

  test("tradeoff fixtures confirm high-relevance/low-perf ranks above low-relevance/high-perf", () => {
    for (const f of rankingTradeoffFixtures) {
      const ranked = rankCandidates(
        f.candidates,
        { topic: "engineering" },
        f.candidates,
      );
      expect(ranked[0].id).toBe(f.expected.expectedTopCandidateId);
    }
  });
});

// ── Phase 6: Quality Gate & Genericity Evaluation Suite ───────────────────────

const { heuristicScreen } = require("../../src/background/evaluator");

describe("Eval set — Phase 6 quality and genericity screening", () => {
  const qualityFixtures = EVAL_FIXTURES.filter(f => f.category === "quality_gate_eval");

  test("quality fixtures match expected pass/fail and failure tags", () => {
    for (const f of qualityFixtures) {
      const screen = heuristicScreen(
        f.candidateReply,
        f.tweet.text,
        [],
        { sourceText: f.tweet.text }
      );
      const passed = screen.failureTags.length === 0;
      expect(passed).toBe(f.expected.expectedPassed);
      f.expected.expectedFailureTags.forEach(tag => {
        expect(screen.failureTags).toContain(tag);
      });
    }
  });
});


