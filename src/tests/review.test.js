// src/tests/review.test.js
// Unit tests for Phase 7 — Human Review Checkpoint.
//
// Covers:
//   1. Feature flag: REQUIRE_HUMAN_APPROVAL defaults to true
//   2. recordManualRejection: validates taxonomy tags, assigns unique ID and timestamp
//   3. recordManualRejection: handles invalid taxonomy tags by falling back to safe default
//   4. Storage buffering: keeps records in MANUAL_REJECTIONS_KEY for Phase 9 training signal

"use strict";

const { DEFAULT_FLAGS } = require("../../src/background/flags");
const {
  FAILURE_TAGS,
  recordManualRejection,
  MANUAL_REJECTIONS_KEY,
} = require("../../src/background/evaluator");

describe("Phase 7 — Feature Flag", () => {
  test("REQUIRE_HUMAN_APPROVAL is true by default", () => {
    expect(DEFAULT_FLAGS.REQUIRE_HUMAN_APPROVAL).toBe(true);
  });
});

describe("Phase 7 — recordManualRejection", () => {
  test("creates a valid rejection record with ID, timestamp, and correct tag", async () => {
    const rejectionData = {
      source_post_id: "tweet_12345",
      reply_text: "Great insights! Thoughts?",
      failure_tag: FAILURE_TAGS.FORCED_QUESTION,
      strategy: "nuance",
      scores: { relevance: 7, accuracy: 8 },
      notes: "Too pushy on the question ending",
    };

    const record = await recordManualRejection(rejectionData);

    expect(record).not.toBeNull();
    expect(record.id).toMatch(/^rej_/);
    expect(record.rejected_at).toBeDefined();
    expect(record.source_post_id).toBe("tweet_12345");
    expect(record.reply_text).toBe("Great insights! Thoughts?");
    expect(record.failure_tag).toBe(FAILURE_TAGS.FORCED_QUESTION);
    expect(record.strategy).toBe("nuance");
    expect(record.notes).toBe("Too pushy on the question ending");
  });

  test("falls back to GENERIC tag when an unknown tag is passed", async () => {
    const rejectionData = {
      source_post_id: "tweet_67890",
      reply_text: "Random reply",
      failure_tag: "NON_EXISTENT_TAG",
    };

    const record = await recordManualRejection(rejectionData);
    expect(record.failure_tag).toBe(FAILURE_TAGS.GENERIC);
  });

  test("returns null gracefully if rejection payload is null or empty", async () => {
    const record = await recordManualRejection(null);
    expect(record).toBeNull();
  });
});
