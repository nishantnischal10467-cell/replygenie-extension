// src/tests/embeddings.test.js
// Unit tests for semantic embedding generation and cosine similarity calculation.

"use strict";

const {
  cosineSimilarity,
  normalizeVector,
  generateLocalEmbedding,
  generateEmbedding,
  EMBEDDING_MODEL,
  _EMBEDDING_CACHE,
} = require("../../src/background/embeddings");

describe("Vector Similarity & Normalization", () => {
  test("computes exact cosine similarity for parallel and orthogonal vectors", () => {
    const vecA = [1, 0, 0];
    const vecB = [1, 0, 0];
    const vecC = [0, 1, 0];
    const vecD = [-1, 0, 0];

    expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(1.0, 5);
    expect(cosineSimilarity(vecA, vecC)).toBeCloseTo(0.0, 5);
    expect(cosineSimilarity(vecA, vecD)).toBeCloseTo(-1.0, 5);
  });

  test("handles empty or invalid vectors gracefully", () => {
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity(null, [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  test("normalizes vectors to unit length (L2 norm = 1.0)", () => {
    const raw = [3, 4, 0];
    const norm = normalizeVector(raw);
    expect(norm).toEqual([0.6, 0.8, 0]);

    const length = Math.sqrt(norm.reduce((acc, v) => acc + v * v, 0));
    expect(length).toBeCloseTo(1.0, 5);
  });
});

describe("Local Embedding Vectorizer", () => {
  test("generates deterministic fixed-length embeddings", () => {
    const v1 = generateLocalEmbedding("Building SaaS applications with AI", 64);
    const v2 = generateLocalEmbedding("Building SaaS applications with AI", 64);
    const v3 = generateLocalEmbedding("Unrelated cooking recipe with tomatoes", 64);

    expect(v1).toHaveLength(64);
    expect(v1).toEqual(v2);

    const simRelated = cosineSimilarity(v1, v2);
    const simUnrelated = cosineSimilarity(v1, v3);

    expect(simRelated).toBeCloseTo(1.0, 4);
    expect(simRelated).toBeGreaterThan(simUnrelated);
  });
});

describe("generateEmbedding Engine & Caching", () => {
  test("caches computed embeddings in memory", async () => {
    _EMBEDDING_CACHE.clear();
    const text = "Consistent habit formation";
    const emb1 = await generateEmbedding(text, null);
    expect(_EMBEDDING_CACHE.size).toBe(1);

    const emb2 = await generateEmbedding(text, null);
    expect(emb1).toEqual(emb2);
  });
});
