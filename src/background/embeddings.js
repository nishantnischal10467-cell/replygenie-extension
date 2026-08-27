// src/background/embeddings.js
// Semantic embedding generation and vector similarity calculation for ReplyGenie.

/* eslint-disable no-var */

var EMBEDDING_MODEL = "text-embedding-3-small";
var EMBEDDING_API_URL = "https://api.openai.com/v1/embeddings";

// In-memory LRU cache to prevent duplicate embedding API calls
var _EMBEDDING_CACHE = new Map();
var _EMBEDDING_CACHE_MAX = 500;

/**
 * Computes cosine similarity between two numeric vectors.
 * @param {Array<number>} vecA
 * @param {Array<number>} vecB
 * @returns {number} similarity score from -1.0 to 1.0 (or 0.0 for invalid vectors)
 */
function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) {
    return 0;
  }
  var minLen = Math.min(vecA.length, vecB.length);
  var dotProduct = 0;
  var normA = 0;
  var normB = 0;

  for (var i = 0; i < minLen; i++) {
    var a = vecA[i] || 0;
    var b = vecB[i] || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Normalizes a vector to unit length.
 * @param {Array<number>} vec
 * @returns {Array<number>}
 */
function normalizeVector(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return [];
  var sumSq = 0;
  for (var i = 0; i < vec.length; i++) {
    sumSq += (vec[i] || 0) * (vec[i] || 0);
  }
  var norm = Math.sqrt(sumSq);
  if (norm === 0) return vec.slice();
  return vec.map(function (val) { return (val || 0) / norm; });
}

var STOP_WORDS = new Set([
  "the", "is", "a", "an", "of", "in", "to", "and", "for", "on", "it", "with", "as",
  "you", "your", "my", "our", "are", "be", "do", "how", "what", "can", "i", "this", "that"
]);

/**
 * Generates a deterministic local character n-gram / term vector.
 * Used for offline mode, unit tests, or fallback when API key is unavailable.
 * @param {string} text
 * @param {number} [dimensions=256]
 * @returns {Array<number>} unit-normalized vector
 */
function generateLocalEmbedding(text, dimensions) {
  dimensions = dimensions || 256;
  var vector = new Array(dimensions).fill(0);
  if (!text || typeof text !== "string") return vector;

  var cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  var rawWords = cleaned.split(/\s+/).filter(Boolean);
  var words = rawWords.filter(function (w) { return !STOP_WORDS.has(w); });

  if (words.length === 0) words = rawWords;

  // Hash words, stems, and bigrams into fixed dimension buckets
  for (var i = 0; i < words.length; i++) {
    var word = words[i];
    var hash1 = 0;
    for (var j = 0; j < word.length; j++) {
      hash1 = (hash1 * 31 + word.charCodeAt(j)) % dimensions;
    }
    vector[hash1] += 2.0;

    // Word stem (first 4-5 chars)
    if (word.length > 4) {
      var stem = word.slice(0, 4);
      var hashStem = 0;
      for (var s = 0; s < stem.length; s++) {
        hashStem = (hashStem * 41 + stem.charCodeAt(s)) % dimensions;
      }
      vector[hashStem] += 1.0;
    }

    if (i < words.length - 1) {
      var bigram = word + "_" + words[i + 1];
      var hash2 = 0;
      for (var k = 0; k < bigram.length; k++) {
        hash2 = (hash2 * 37 + bigram.charCodeAt(k)) % dimensions;
      }
      vector[hash2] += 2.5;
    }
  }

  return normalizeVector(vector);
}

/**
 * Generates semantic embedding using OpenAI text-embedding-3-small with LRU cache
 * and fallback to local vectorizer.
 * @param {string} text
 * @param {string} [apiKey]
 * @param {Object} [options]
 * @returns {Promise<Array<number>>}
 */
async function generateEmbedding(text, apiKey, options) {
  options = options || {};
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return generateLocalEmbedding("", 64);
  }

  var normalizedText = text.trim();
  var cacheKey = normalizedText.slice(0, 300);

  if (_EMBEDDING_CACHE.has(cacheKey)) {
    return _EMBEDDING_CACHE.get(cacheKey);
  }

  if (!apiKey) {
    var localVec = generateLocalEmbedding(normalizedText, options.dimensions || 64);
    _EMBEDDING_CACHE.set(cacheKey, localVec);
    return localVec;
  }

  try {
    var res = await fetch(EMBEDDING_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: normalizedText.slice(0, 2000), // Enforce token limit boundary
      }),
    });

    if (!res.ok) {
      console.warn("[ReplyGenie] Embeddings API returned status " + res.status + ". Falling back to local vector.");
      return generateLocalEmbedding(normalizedText, 64);
    }

    var data = await res.json();
    if (data && data.data && data.data[0] && Array.isArray(data.data[0].embedding)) {
      var embedding = normalizeVector(data.data[0].embedding);

      // LRU cache maintenance
      if (_EMBEDDING_CACHE.size >= _EMBEDDING_CACHE_MAX) {
        var firstKey = _EMBEDDING_CACHE.keys().next().value;
        _EMBEDDING_CACHE.delete(firstKey);
      }
      _EMBEDDING_CACHE.set(cacheKey, embedding);

      return embedding;
    }
  } catch (err) {
    console.warn("[ReplyGenie] Embedding fetch error:", err.message);
  }

  return generateLocalEmbedding(normalizedText, 64);
}

// Node.js / Jest exports
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    EMBEDDING_MODEL,
    cosineSimilarity,
    normalizeVector,
    generateLocalEmbedding,
    generateEmbedding,
    _EMBEDDING_CACHE,
  };
}
