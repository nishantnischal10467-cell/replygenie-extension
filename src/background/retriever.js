// src/background/retriever.js
// ReplyRetriever: semantic similarity search against the replies database.
// Retrieves 20-50 candidates without performance filtering (Phase 4 handles performance).

/* eslint-disable no-var */

if (typeof openDatabase === "undefined" && typeof require !== "undefined") {
  var database = require("./db/database");
  var schema = require("./db/schema");
  var embeddings = require("./embeddings");
  var analyzer = require("./analyzer");

  var openDatabase = database.openDatabase;
  var STORES = schema.STORES;
  var cosineSimilarity = embeddings.cosineSimilarity;
  var generateEmbedding = embeddings.generateEmbedding;
  var generateLocalEmbedding = embeddings.generateLocalEmbedding;
  var analyzePostHeuristic = analyzer.analyzePostHeuristic;
}

var RETRIEVER_DEFAULTS = {
  CANDIDATE_LIMIT: 30,            // Retrieve ~20-50 candidates
  MIN_SIMILARITY_THRESHOLD: 0.20, // Minimum threshold to count as a candidate
  HIGH_CONFIDENCE_THRESHOLD: 0.50,
  MEDIUM_CONFIDENCE_THRESHOLD: 0.30,
};

/**
 * Retrieves similar reply candidates from the IndexedDB replies store based on semantic vector similarity.
 * Gracefully handles empty stores or zero matching records.
 *
 * @param {Object|string} query - query text or object with { text, embedding, topic, intent }
 * @param {Object} [options] - { limit, apiKey, minSimilarityThreshold }
 * @returns {Promise<{candidates: Array, confidence: string, count: number, queryAnalysis: Object}>}
 */
async function retrieveCandidates(query, options) {
  options = options || {};
  var limit = options.limit || RETRIEVER_DEFAULTS.CANDIDATE_LIMIT;
  var minThreshold = options.minSimilarityThreshold !== undefined
    ? options.minSimilarityThreshold
    : RETRIEVER_DEFAULTS.MIN_SIMILARITY_THRESHOLD;

  var queryText = typeof query === "string" ? query : (query && query.text ? query.text : "");
  var queryAnalysis = analyzePostHeuristic({ text: queryText });

  if (!queryText || queryText.trim().length === 0) {
    return {
      candidates: [],
      confidence: "none",
      count: 0,
      queryAnalysis: queryAnalysis,
    };
  }

  // 1. Generate query embedding (or use pre-computed if provided)
  var queryEmbedding = (query && Array.isArray(query.embedding) && query.embedding.length > 0)
    ? query.embedding
    : await generateEmbedding(queryText, options.apiKey);

  var db = await openDatabase();
  var tx = db.transaction(STORES.REPLIES, "readonly");
  var store = tx.objectStore(STORES.REPLIES);

  // 2. Fetch all stored replies for in-memory semantic similarity ranking
  var storedReplies = await new Promise(function (resolve, reject) {
    var req = store.getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { reject(req.error); };
  });

  if (storedReplies.length === 0) {
    return {
      candidates: [],
      confidence: "none",
      count: 0,
      queryAnalysis: queryAnalysis,
      message: "Reply database is empty.",
    };
  }

  // 3. Score each stored reply
  var scored = [];

  for (var i = 0; i < storedReplies.length; i++) {
    var reply = storedReplies[i];
    var replyText = reply.reply_text || "";
    if (!replyText) continue;

    var replyVec = Array.isArray(reply.embedding) && reply.embedding.length > 0
      ? reply.embedding
      : generateLocalEmbedding(replyText);

    var simScore = cosineSimilarity(queryEmbedding, replyVec);

    // Topic boost if topics match and base similarity is non-trivial
    var topicBoost = 0;
    if (simScore > 0.12 && queryAnalysis.topic && reply.topic && queryAnalysis.topic === reply.topic && queryAnalysis.topic !== "general") {
      topicBoost = 0.10;
    }

    var totalScore = Math.min(1.0, Math.max(0.0, simScore + topicBoost));

    if (totalScore >= minThreshold && simScore > 0.05) {
      scored.push({
        id:                         reply.id,
        reply_text:                 reply.reply_text,
        topic:                      reply.topic,
        intent:                     reply.intent,
        reply_strategy:             reply.reply_strategy,
        similarity_score:           Number(simScore.toFixed(4)),
        total_score:                Number(totalScore.toFixed(4)),
        is_human_written:           reply.is_human_written,
        is_ai_generated:            reply.is_ai_generated,
        generation_prompt_version:  reply.generation_prompt_version,
      });
    }
  }

  // 4. Sort by score descending
  scored.sort(function (a, b) { return b.total_score - a.total_score; });

  var candidates = scored.slice(0, limit);

  // 5. Determine confidence tier
  var confidence = "none";
  if (candidates.length > 0) {
    var topScore = candidates[0].total_score;
    if (topScore >= RETRIEVER_DEFAULTS.HIGH_CONFIDENCE_THRESHOLD) {
      confidence = "high";
    } else if (topScore >= RETRIEVER_DEFAULTS.MEDIUM_CONFIDENCE_THRESHOLD) {
      confidence = "medium";
    } else if (topScore >= 0.15) {
      confidence = "low";
    } else {
      confidence = "none";
    }
  }

  return {
    candidates: candidates,
    confidence: confidence,
    count: candidates.length,
    queryAnalysis: queryAnalysis,
  };
}

// Node.js / Jest exports
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RETRIEVER_DEFAULTS,
    retrieveCandidates,
  };
}
