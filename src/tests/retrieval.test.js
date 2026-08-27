// src/tests/retrieval.test.js
// Unit tests for ReplyRetriever semantic candidate retrieval and eval verification.

"use strict";

const { retrieveCandidates, RETRIEVER_DEFAULTS } = require("../../src/background/retriever");
const { resetDatabase, repliesRepo } = require("../../src/background/db/database");
const { EVAL_FIXTURES } = require("./eval/fixtures");

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
});

describe("ReplyRetriever Semantic Candidate Search", () => {
  test("returns empty candidates with confidence 'none' when database is empty", async () => {
    const res = await retrieveCandidates("How to launch a SaaS?");
    expect(res.candidates).toEqual([]);
    expect(res.confidence).toBe("none");
    expect(res.count).toBe(0);
    expect(res.queryAnalysis).toBeDefined();
  });

  test("retrieves and ranks relevant candidates from the database for sample posts", async () => {
    // Seed database with diverse replies
    await repliesRepo.insertReply({
      reply_text: "The best way to get initial SaaS customers is 1-on-1 direct outreach on X.",
      topic: "saas_builder",
      reply_strategy: "direct_advice",
    });

    await repliesRepo.insertReply({
      reply_text: "Prompt engineering gives 80% of the value before touching fine-tuning.",
      topic: "ai",
      reply_strategy: "contrarian_take",
    });

    await repliesRepo.insertReply({
      reply_text: "Video content has 3x higher retention than static images right now.",
      topic: "marketing",
      reply_strategy: "data_point",
    });

    await repliesRepo.insertReply({
      reply_text: "Rust gives zero-cost abstractions and fearless concurrency.",
      topic: "engineering",
      reply_strategy: "technical_depth",
    });

    await repliesRepo.insertReply({
      reply_text: "Deep work blocks in the morning protect your energy from Slack chaos.",
      topic: "productivity",
      reply_strategy: "personal_experience",
    });

    // Test 1: SaaS query
    const saasRes = await retrieveCandidates("How can I find first customers for my B2B SaaS startup?");
    expect(saasRes.candidates.length).toBeGreaterThanOrEqual(1);
    expect(saasRes.candidates[0].reply_text).toContain("SaaS customers");
    expect(saasRes.confidence).not.toBe("none");

    // Test 2: AI query
    const aiRes = await retrieveCandidates("Is fine-tuning better than prompt engineering?");
    expect(aiRes.candidates.length).toBeGreaterThanOrEqual(1);
    expect(aiRes.candidates[0].reply_text).toContain("Prompt engineering");

    // Test 3: Unrelated query should return low/none confidence
    const unrelatedRes = await retrieveCandidates("xyz abc 987 unrelated random text");
    expect(unrelatedRes.confidence).toBe("none");
  });

  test("respects limit option to retrieve between 20 and 50 candidates", async () => {
    // Seed 40 replies
    for (let i = 0; i < 40; i++) {
      await repliesRepo.insertReply({
        reply_text: "Candidate reply number " + i + " on SaaS growth and building products.",
        topic: "saas_builder",
      });
    }

    const res = await retrieveCandidates("How to grow SaaS?", { limit: 25 });
    expect(res.candidates.length).toBe(25);
  });
});

describe("Eval Set Retrieval Verification", () => {
  test("verifies retrieval against Phase 3 eval fixture cases", async () => {
    // Seed database with fixture topic answers
    await repliesRepo.insertReply({
      reply_text: "Focus on cold DMing founders who actively discuss your problem area on X.",
      topic: "saas_builder",
    });
    await repliesRepo.insertReply({
      reply_text: "Clean RAG pipeline with hybrid search beats blind model fine-tuning every time.",
      topic: "ai",
    });
    await repliesRepo.insertReply({
      reply_text: "Short-form video algorithms prioritize completion rate over pure follower count.",
      topic: "marketing",
    });
    await repliesRepo.insertReply({
      reply_text: "Switching from Python to Rust cut our cloud server costs by 70%.",
      topic: "engineering",
    });
    await repliesRepo.insertReply({
      reply_text: "Protecting 9am-12pm as focus time prevents cognitive context switching.",
      topic: "productivity",
    });

    const retrievalFixtures = EVAL_FIXTURES.filter(f => f.category === "retrieval_eval");
    expect(retrievalFixtures.length).toBeGreaterThanOrEqual(5);

    for (const f of retrievalFixtures) {
      const res = await retrieveCandidates(f.tweet.text);
      if (f.expected.expectedMinCandidates > 0) {
        expect(res.candidates.length).toBeGreaterThanOrEqual(f.expected.expectedMinCandidates);
      } else {
        expect(["none", "low"]).toContain(res.confidence);
      }
    }
  });
});
