// src/background/ranker.js
// ReplyRanker — Phase 4 Performance-Aware Candidate Ranking.
//
// Ranking philosophy:
//   candidate_score = relevance_base + performance_bonus
//   Relevance is the primary determinant. Performance acts as a bonus
//   multiplier on top of relevance — it never overrides a semantically
//   irrelevant candidate. A high-performance / low-relevance reply
//   will always rank below a low-performance / high-relevance one.
//
// TUNING NOTE: Default weights below are reasonable starting assumptions.
// They MUST be re-tuned once real engagement data accumulates (≥200 replies).
// Surface them in options.html or a config panel so the user can adjust.

/* eslint-disable no-var */

// ── Performance Classification Thresholds ────────────────────────────────────
// Per spec: OUTSTANDING ≥ 10,000 | MODERATE 500–9,999 | BASELINE < 500
// Exact boundary values required: 499/500/9999/10000

var PERFORMANCE_CLASSES = {
  OUTSTANDING: "outstanding", // ≥ 10,000 impressions
  MODERATE:    "moderate",    //   500 – 9,999 impressions
  BASELINE:    "baseline",    //     < 500 impressions
};

var PERFORMANCE_THRESHOLDS = {
  OUTSTANDING_MIN: 10000, // inclusive lower bound for OUTSTANDING
  MODERATE_MIN:    500,   // inclusive lower bound for MODERATE
  // BASELINE: < MODERATE_MIN
};

// ── Performance Score Weights (default, config-driven) ───────────────────────
// These are defaults. Override via chrome.storage or rankerConfig argument.
// Sum of all positive weights ≠ 1.0 by design — score is normalized in [0,1].

var DEFAULT_PERFORMANCE_WEIGHTS = {
  // Engagement metric coefficients
  impressions:        0.30, // Reach signal — highest weight
  likes:              0.25, // Explicit approval
  reply_count:        0.20, // Conversational pull / reach multiplier
  reposts:            0.15, // Distribution amplification
  bookmarks:          0.05, // Save-for-later quality signal
  profile_visits:     0.05, // Downstream account growth signal

  // Bonus / penalty adjustments
  author_reply_bonus:       0.15, // Flat bonus when original author replied
  negative_feedback_penalty: 0.20, // Flat penalty when hide/block/mute detected
};

// ── Candidate Score Weights (default, config-driven) ─────────────────────────
// Relevance components sum to 1.0. Performance is an additive bonus capped
// so it cannot override relevance direction.

var DEFAULT_CANDIDATE_WEIGHTS = {
  // Relevance (primary) — MUST dominate
  semantic_similarity: 0.40, // Cosine vector similarity (Phase 3)
  topic_similarity:    0.20, // Boolean topic match converted to 0/1
  strategy_match:      0.10, // Boolean strategy match converted to 0/1
  voice_similarity:    0.15, // Voice profile congruence score
  recency_score:       0.10, // Decayed freshness score [0,1]
  novelty_score:       0.05, // Diversity bonus against already-seen replies

  // Performance (bonus, additive, capped)
  performance_bonus_cap:   0.20, // Maximum performance can add to candidate score
  performance_bonus_weight: 0.25, // How much of performance_score maps to the bonus
};

// ── Recency Decay Parameters ─────────────────────────────────────────────────
var RECENCY_HALF_LIFE_DAYS = 60; // Score halves every 60 days (configurable)

// ── Percentile Normalization Pool Cap ────────────────────────────────────────
// Max records scanned for normalization to cap latency on large reply sets.
var NORMALIZATION_POOL_LIMIT = 500;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Performance Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies a reply by impressions into OUTSTANDING / MODERATE / BASELINE.
 * Exact boundary spec: 499=BASELINE, 500=MODERATE, 9999=MODERATE, 10000=OUTSTANDING.
 * @param {number} impressions
 * @returns {string} one of PERFORMANCE_CLASSES values
 */
function classifyPerformance(impressions) {
  var imp = typeof impressions === "number" ? impressions : 0;
  if (imp >= PERFORMANCE_THRESHOLDS.OUTSTANDING_MIN) return PERFORMANCE_CLASSES.OUTSTANDING;
  if (imp >= PERFORMANCE_THRESHOLDS.MODERATE_MIN)    return PERFORMANCE_CLASSES.MODERATE;
  return PERFORMANCE_CLASSES.BASELINE;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Percentile Normalization Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes percentile rank of `value` within `pool` array.
 * Returns 0.0 if pool is empty or all values equal.
 * @param {number} value
 * @param {Array<number>} pool - all observed values for this metric
 * @returns {number} [0.0, 1.0]
 */
function percentileRank(value, pool) {
  if (!pool || pool.length === 0) return 0;
  var sorted = pool.slice().sort(function (a, b) { return a - b; });
  var max = sorted[sorted.length - 1];
  var min = sorted[0];
  if (max === min) return 0.5; // All values equal — assign midpoint
  // Linear interpolation for percentile
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/**
 * Normalizes a single metric value using min-max scaling over pool.
 * Falls back to safe clamped ratio when pool is unavailable.
 * @param {number} value
 * @param {Array<number>|null} pool
 * @param {number} [naiveCap=50000]
 * @returns {number} [0.0, 1.0]
 */
function normalizeMetric(value, pool, naiveCap) {
  if (pool && pool.length > 1) {
    return percentileRank(value, pool);
  }
  naiveCap = naiveCap || 50000;
  return Math.max(0, Math.min(1, (value || 0) / naiveCap));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. reply_impression_ratio
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the ratio of reply impressions to source post impressions.
 * Normalizes against virality — a reply under a 1M-impression tweet
 * should not be classified OUTSTANDING on absolute impressions alone.
 *
 * Returns null when source_post_impressions is unavailable (Phase 9 concern).
 * @param {number} reply_impressions
 * @param {number|null} source_post_impressions
 * @returns {number|null} [0.0, +∞) or null
 */
function computeImpressionRatio(reply_impressions, source_post_impressions) {
  if (typeof source_post_impressions !== "number" || source_post_impressions <= 0) {
    return null; // Source impressions not yet available — deferred to Phase 9
  }
  return (reply_impressions || 0) / source_post_impressions;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Per-reply Performance Score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes a normalized composite performance_score [0.0, 1.0] for a single reply
 * using percentile normalization across a pool of observed values.
 *
 * @param {Object} reply  — reply record from the DB
 * @param {Object} pools  — { impressions: number[], likes: number[], ... }
 * @param {Object} [weights] — override DEFAULT_PERFORMANCE_WEIGHTS
 * @returns {Object} { performance_score, performance_class, impression_ratio, normalized_metrics }
 */
function computePerformanceScore(reply, pools, weights) {
  pools   = pools   || {};
  weights = Object.assign({}, DEFAULT_PERFORMANCE_WEIGHTS, weights || {});

  var imp     = reply.impressions      || 0;
  var lk      = reply.likes            || 0;
  var rep     = reply.replies          || 0;
  var rst     = reply.reposts          || 0;
  var bk      = reply.bookmarks        || 0;
  var pv      = reply.profile_visits   || 0;
  var authorR = reply.author_replied   ? 1 : 0;
  var negFb   = reply.negative_feedback ? 1 : 0;

  var nImp = normalizeMetric(imp, pools.impressions);
  var nLk  = normalizeMetric(lk,  pools.likes);
  var nRep = normalizeMetric(rep, pools.reply_count);
  var nRst = normalizeMetric(rst, pools.reposts);
  var nBk  = normalizeMetric(bk,  pools.bookmarks);
  var nPv  = normalizeMetric(pv,  pools.profile_visits);

  // Compute weighted sum of positive metrics
  var rawScore =
    (nImp * weights.impressions) +
    (nLk  * weights.likes)       +
    (nRep * weights.reply_count) +
    (nRst * weights.reposts)     +
    (nBk  * weights.bookmarks)   +
    (nPv  * weights.profile_visits);

  // Normalize raw score to [0,1] using the sum of all positive weights
  var totalPositiveWeight =
    weights.impressions + weights.likes + weights.reply_count +
    weights.reposts + weights.bookmarks + weights.profile_visits;

  var normalized = totalPositiveWeight > 0 ? rawScore / totalPositiveWeight : 0;

  // Apply bonus/penalty
  normalized += authorR * weights.author_reply_bonus;
  normalized -= negFb   * weights.negative_feedback_penalty;

  var performanceScore = Math.max(0, Math.min(1, normalized));

  // impression_ratio (requires source post impressions — may be null)
  var impressionRatio = computeImpressionRatio(imp, reply.source_post_impressions || null);

  return {
    performance_score: Number(performanceScore.toFixed(4)),
    performance_class: classifyPerformance(imp),
    impression_ratio:  impressionRatio !== null ? Number(impressionRatio.toFixed(4)) : null,
    normalized_metrics: {
      impressions:    Number(nImp.toFixed(4)),
      likes:          Number(nLk.toFixed(4)),
      reply_count:    Number(nRep.toFixed(4)),
      reposts:        Number(nRst.toFixed(4)),
      bookmarks:      Number(nBk.toFixed(4)),
      profile_visits: Number(nPv.toFixed(4)),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Recency Score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exponential decay recency score. Newer replies score higher.
 * @param {string|number} created_at  — ISO string or Unix ms timestamp
 * @param {number} [halfLifeDays]     — configurable half-life (default 60 days)
 * @returns {number} [0.0, 1.0]
 */
function computeRecencyScore(created_at, halfLifeDays) {
  halfLifeDays = halfLifeDays || RECENCY_HALF_LIFE_DAYS;
  var ts  = created_at ? new Date(created_at).getTime() : 0;
  if (!ts) return 0;
  var ageMs   = Math.max(0, Date.now() - ts);
  var ageDays = ageMs / (1000 * 60 * 60 * 24);
  var lambda  = Math.LN2 / halfLifeDays; // decay constant
  return Math.exp(-lambda * ageDays);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Novelty Score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Novelty score: penalizes replies whose text is very similar to already-ranked
 * candidates (MMR-lite — Maximal Marginal Relevance).
 * Returns 1.0 (fully novel) for the first candidate, decays as duplicates appear.
 * @param {string} replyText
 * @param {Array<string>} alreadyRankedTexts — texts of candidates already selected
 * @param {Function} similarityFn — cosineSimilarity or equivalent
 * @param {Function} embedFn      — generateLocalEmbedding or equivalent
 * @returns {number} [0.0, 1.0]
 */
function computeNoveltyScore(replyText, alreadyRankedTexts, similarityFn, embedFn) {
  if (!alreadyRankedTexts || alreadyRankedTexts.length === 0) return 1.0;
  if (!replyText) return 0;

  // If no vector functions provided, use simple word-overlap Jaccard
  if (typeof embedFn !== "function" || typeof similarityFn !== "function") {
    var setA = new Set(replyText.toLowerCase().split(/\s+/));
    var maxJaccard = 0;
    alreadyRankedTexts.forEach(function (other) {
      var setB = new Set(other.toLowerCase().split(/\s+/));
      var intersection = 0;
      setA.forEach(function (w) { if (setB.has(w)) intersection++; });
      var union = setA.size + setB.size - intersection;
      var j = union > 0 ? intersection / union : 0;
      if (j > maxJaccard) maxJaccard = j;
    });
    return Math.max(0, 1 - maxJaccard);
  }

  var vecA = embedFn(replyText);
  var maxSim = 0;
  alreadyRankedTexts.forEach(function (other) {
    var vecB = embedFn(other);
    var sim = similarityFn(vecA, vecB);
    if (sim > maxSim) maxSim = sim;
  });
  return Math.max(0, 1 - maxSim);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Composite Candidate Score (final ranking formula)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the final candidate_score for a retrieved reply candidate.
 *
 * Formula (invariant — tested):
 *   relevance_base = (semantic_similarity * w.semantic_similarity)
 *                  + (topic_sim           * w.topic_similarity)
 *                  + (strategy_match      * w.strategy_match)
 *                  + (voice_similarity    * w.voice_similarity)
 *                  + (recency_score       * w.recency_score)
 *                  + (novelty_score       * w.novelty_score)
 *
 *   performance_bonus = min(performance_score * w.performance_bonus_weight,
 *                           w.performance_bonus_cap)
 *
 *   candidate_score = clamp(relevance_base + performance_bonus, 0, 1)
 *
 * INVARIANT: high_relevance/low_perf ALWAYS beats low_relevance/high_perf
 * (tested in ranker.test.js — relevance_dominance test).
 *
 * @param {Object} candidate     — retrieved reply candidate (from Phase 3)
 * @param {Object} inputs        — { topic_similarity, strategy_match, voice_similarity, recency_score, novelty_score }
 * @param {number} performanceScore — pre-computed performance_score [0,1]
 * @param {Object} [weights]     — override DEFAULT_CANDIDATE_WEIGHTS
 * @returns {Object} { candidate_score, relevance_base, performance_bonus, components }
 */
function computeCandidateScore(candidate, inputs, performanceScore, weights) {
  weights = Object.assign({}, DEFAULT_CANDIDATE_WEIGHTS, weights || {});
  inputs  = inputs || {};

  var semanticSim  = typeof candidate.similarity_score === "number" ? candidate.similarity_score : 0;
  var topicSim     = typeof inputs.topic_similarity    === "number" ? inputs.topic_similarity    : 0;
  var strategyM    = typeof inputs.strategy_match      === "number" ? inputs.strategy_match      : 0;
  var voiceSim     = typeof inputs.voice_similarity    === "number" ? inputs.voice_similarity    : 0;
  var recency      = typeof inputs.recency_score       === "number" ? inputs.recency_score       : 0;
  var novelty      = typeof inputs.novelty_score       === "number" ? inputs.novelty_score       : 0;
  var perfScore    = typeof performanceScore           === "number" ? performanceScore           : 0;

  var relevanceBase =
    (semanticSim * weights.semantic_similarity) +
    (topicSim    * weights.topic_similarity)    +
    (strategyM   * weights.strategy_match)      +
    (voiceSim    * weights.voice_similarity)    +
    (recency     * weights.recency_score)       +
    (novelty     * weights.novelty_score);

  var performanceBonus = Math.min(
    perfScore * weights.performance_bonus_weight,
    weights.performance_bonus_cap
  );

  var candidateScore = Math.max(0, Math.min(1, relevanceBase + performanceBonus));

  return {
    candidate_score:   Number(candidateScore.toFixed(4)),
    relevance_base:    Number(relevanceBase.toFixed(4)),
    performance_bonus: Number(performanceBonus.toFixed(4)),
    components: {
      semantic_similarity: Number(semanticSim.toFixed(4)),
      topic_similarity:    Number(topicSim.toFixed(4)),
      strategy_match:      Number(strategyM.toFixed(4)),
      voice_similarity:    Number(voiceSim.toFixed(4)),
      recency_score:       Number(recency.toFixed(4)),
      novelty_score:       Number(novelty.toFixed(4)),
      performance_score:   Number(perfScore.toFixed(4)),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Build normalization pools from a reply array
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts per-metric value pools from a set of reply records for percentile normalization.
 * Scans at most NORMALIZATION_POOL_LIMIT records for performance.
 * @param {Array<Object>} replies
 * @returns {Object} pools { impressions, likes, reply_count, reposts, bookmarks, profile_visits }
 */
function buildNormalizationPools(replies) {
  var records = (replies || []).slice(0, NORMALIZATION_POOL_LIMIT);
  var pools = {
    impressions:    [],
    likes:          [],
    reply_count:    [],
    reposts:        [],
    bookmarks:      [],
    profile_visits: [],
  };
  records.forEach(function (r) {
    pools.impressions.push(r.impressions || 0);
    pools.likes.push(r.likes || 0);
    pools.reply_count.push(r.replies || 0);
    pools.reposts.push(r.reposts || 0);
    pools.bookmarks.push(r.bookmarks || 0);
    pools.profile_visits.push(r.profile_visits || 0);
  });
  return pools;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Full Ranker Pipeline — rank a list of candidates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ranks an array of retrieval candidates using the full performance-aware formula.
 *
 * @param {Array<Object>} candidates     — Phase 3 ReplyRetriever output
 * @param {Object} queryAnalysis         — PostAnalyzer output (topic, intent)
 * @param {Array<Object>} performancePool — historical replies for pool normalization
 * @param {Object} [options]
 *   - weights.performance: override DEFAULT_PERFORMANCE_WEIGHTS
 *   - weights.candidate:   override DEFAULT_CANDIDATE_WEIGHTS
 *   - voiceProfile:        active voice profile (for voice_similarity check)
 *   - embedFn:             generateLocalEmbedding function
 *   - similarityFn:        cosineSimilarity function
 * @returns {Array<Object>} ranked candidates with candidate_score injected, sorted descending
 */
function rankCandidates(candidates, queryAnalysis, performancePool, options) {
  options       = options       || {};
  queryAnalysis = queryAnalysis || {};
  var perfWeights  = Object.assign({}, DEFAULT_PERFORMANCE_WEIGHTS,  (options.weights && options.weights.performance) || {});
  var candWeights  = Object.assign({}, DEFAULT_CANDIDATE_WEIGHTS, (options.weights && options.weights.candidate) || {});
  var embedFn      = options.embedFn      || null;
  var similarityFn = options.similarityFn || null;

  if (!candidates || candidates.length === 0) return [];

  var pools = buildNormalizationPools(performancePool || candidates);
  var rankedTexts = []; // For novelty MMR

  return candidates.map(function (c) {
    // 4a. Performance score
    var perfResult = computePerformanceScore(c, pools, perfWeights);

    // 4b. Recency score
    var recency = computeRecencyScore(c.created_at);

    // 4c. Novelty score
    var novelty = computeNoveltyScore(c.reply_text, rankedTexts, similarityFn, embedFn);

    // 4d. Topic similarity (0.0 or 1.0)
    var topicSim = (queryAnalysis.topic && c.topic && queryAnalysis.topic === c.topic && c.topic !== "general")
      ? 1.0 : 0.0;

    // 4e. Strategy match (0.0 or 1.0)
    var strategyMatch = (queryAnalysis.preferred_strategy && c.reply_strategy &&
                         queryAnalysis.preferred_strategy === c.reply_strategy) ? 1.0 : 0.0;

    // 4f. Voice similarity (use stored score if available)
    var voiceSim = typeof c.voice_similarity_score === "number" ? c.voice_similarity_score : 0.5;

    // 4g. Composite candidate score
    var scoring = computeCandidateScore(
      c,
      { topic_similarity: topicSim, strategy_match: strategyMatch, voice_similarity: voiceSim, recency_score: recency, novelty_score: novelty },
      perfResult.performance_score,
      candWeights
    );

    rankedTexts.push(c.reply_text || "");

    return Object.assign({}, c, {
      candidate_score:    scoring.candidate_score,
      relevance_base:     scoring.relevance_base,
      performance_bonus:  scoring.performance_bonus,
      performance_score:  perfResult.performance_score,
      performance_class:  perfResult.performance_class,
      impression_ratio:   perfResult.impression_ratio,
      recency_score:      Number(recency.toFixed(4)),
      novelty_score:      Number(novelty.toFixed(4)),
      score_components:   scoring.components,
    });
  }).sort(function (a, b) { return b.candidate_score - a.candidate_score; });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PERFORMANCE_CLASSES,
    PERFORMANCE_THRESHOLDS,
    DEFAULT_PERFORMANCE_WEIGHTS,
    DEFAULT_CANDIDATE_WEIGHTS,
    RECENCY_HALF_LIFE_DAYS,
    NORMALIZATION_POOL_LIMIT,
    classifyPerformance,
    percentileRank,
    normalizeMetric,
    computeImpressionRatio,
    computePerformanceScore,
    computeRecencyScore,
    computeNoveltyScore,
    computeCandidateScore,
    buildNormalizationPools,
    rankCandidates,
  };
}
