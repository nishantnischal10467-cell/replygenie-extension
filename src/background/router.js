// src/background/router.js
// Phase 5 — Confidence Router
//
// Given the top-ranked retrieval candidate and the current context, determines
// which generation path to take:
//
//   ADAPT   — best candidate is high-confidence; ReplyAdapter refines it
//   INSPIRE — candidate is mid-band; used only as inspiration for ReplyGenerator
//   GENERATE — no strong candidate; ReplyGenerator runs from scratch
//
// Design constraint:
//   All thresholds are config values — never hardcode floats directly in
//   routing conditions.  Pass a `thresholds` override to routeCandidate()
//   to tune per-account without touching this file.
//
// IMPORTANT: This module contains NO OpenAI calls.  It is a pure decision
// function — safe to test in Node.js without any mocking.

/* eslint-disable no-var */

// ── Route labels ─────────────────────────────────────────────────────────────

var ROUTE = {
  ADAPT:    "adapt",    // Use + adapt top candidate via ReplyAdapter
  INSPIRE:  "inspire",  // Use as inspiration input to ReplyGenerator
  GENERATE: "generate", // Generate from scratch via ReplyGenerator
};

// ── Default routing thresholds (config-driven, all overridable) ───────────────
//
// TUNING NOTE: These defaults work well for initial deployment. Calibrate
// after ≥ 200 ranked replies with real performance data.
//
//   HIGH_CONFIDENCE_SIMILARITY   — candidate must meet or exceed this to be adapted
//   MEDIUM_BAND_LOW              — lower bound of the inspiration band (inclusive)
//   MEDIUM_BAND_HIGH             — upper bound of the inspiration band (exclusive, == HIGH_CONFIDENCE_SIMILARITY)
//   MIN_PERFORMANCE_SCORE        — candidate must have this perf score for ADAPT path
//   MAX_STALENESS_DAYS           — candidates older than this are never adapted
//   NOVELTY_FLOOR                — candidate must have at least this novelty score for ADAPT
//   RECENCY_FLOOR                — candidate must have at least this recency score for ADAPT
//   RECENTLY_POSTED_SIMILARITY   — similarity threshold against recently-posted replies
//                                  (if candidate text is too similar to a recent reply → fall to INSPIRE)

var DEFAULT_ROUTING_THRESHOLDS = {
  HIGH_CONFIDENCE_SIMILARITY:  0.90, // ≥ this → eligible for ADAPT
  MEDIUM_BAND_LOW:             0.80, // ≥ this AND < HIGH_CONFIDENCE_SIMILARITY → INSPIRE
  MEDIUM_BAND_HIGH:            0.90, // exclusive upper bound of inspire band (== HIGH_CONFIDENCE_SIMILARITY)
  MIN_PERFORMANCE_SCORE:       0.20, // ADAPT requires at least this performance score
  MAX_STALENESS_DAYS:          90,   // Candidates older than this are never adapted
  NOVELTY_FLOOR:               0.30, // ADAPT requires candidate to be reasonably novel vs recent replies
  RECENCY_FLOOR:               0.10, // ADAPT requires candidate to have some recency score
  RECENTLY_POSTED_SIMILARITY:  0.80, // If top candidate text overlaps a recent reply this much → INSPIRE
};

// ── Staleness check ───────────────────────────────────────────────────────────

/**
 * Returns true if the candidate is older than maxStalenessdays.
 * Checks both age and a simple context-specificity heuristic
 * (contains year references that no longer match the current year).
 *
 * @param {Object} candidate
 * @param {number} maxStalenessdays
 * @returns {{ stale: boolean, reason: string|null }}
 */
function checkStaleness(candidate, maxStalenessdays) {
  // Age check
  if (candidate.created_at) {
    var createdAt = new Date(candidate.created_at).getTime();
    if (createdAt) {
      var ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
      if (ageDays > maxStalenessdays) {
        return { stale: true, reason: "age_exceeded:" + Math.round(ageDays) + "d" };
      }
    }
  }

  // Context-specificity heuristic: detect year references that no longer match
  var text = (candidate.reply_text || "").toLowerCase();
  var currentYear = new Date().getFullYear();
  var years = text.match(/\b(20\d{2})\b/g);
  if (years) {
    for (var i = 0; i < years.length; i++) {
      var y = parseInt(years[i], 10);
      // A past-year reference more than 2 years old in a dated reply is context-stale
      if (y < currentYear - 2) {
        return { stale: true, reason: "dated_year_reference:" + y };
      }
    }
  }

  return { stale: false, reason: null };
}

// ── Anti-repetition guard ─────────────────────────────────────────────────────

/**
 * Returns true if the candidate text is too similar to any recently-posted reply.
 * Uses Jaccard word-overlap (no vectors required — safe for all callers).
 *
 * @param {string} candidateText
 * @param {Array<string>} recentReplies  — recent reply texts
 * @param {number} similarityThreshold  — 0.0–1.0
 * @returns {boolean}
 */
function isTooSimilarToRecent(candidateText, recentReplies, similarityThreshold) {
  if (!recentReplies || recentReplies.length === 0) return false;
  if (!candidateText) return false;
  var setA = new Set(candidateText.toLowerCase().split(/\s+/));
  for (var i = 0; i < recentReplies.length; i++) {
    var other = recentReplies[i];
    if (!other) continue;
    var setB = new Set(other.toLowerCase().split(/\s+/));
    var intersection = 0;
    setA.forEach(function (w) { if (setB.has(w)) intersection++; });
    var union = setA.size + setB.size - intersection;
    var j = union > 0 ? intersection / union : 0;
    if (j >= similarityThreshold) return true;
  }
  return false;
}

// ── Contradiction guard ───────────────────────────────────────────────────────
//
// A stored reply may contradict the current post if it was written as a
// rebuttal/disagreement and the current post makes the same claim.
// HEURISTIC: if the candidate strategy is "respectful_disagreement" or
// "useful_correction" and the current post's topic/intent is strongly aligned
// with the candidate's source post (high similarity), flag as contradiction risk.
//
// Full contradiction detection (via LLM) is deferred to Phase 7.
// This is the lightweight heuristic guard.

/**
 * Returns true if the candidate strategy could contradict the current context.
 * @param {Object} candidate
 * @param {Object} analysis  — PostAnalyzer output
 * @returns {boolean}
 */
function mayContradictCurrentPost(candidate, analysis) {
  var contradictoryStrategies = ["respectful_disagreement", "useful_correction", "contrarian_observation"];
  var candidateStrategy = (candidate.reply_strategy || "").toLowerCase();
  if (!contradictoryStrategies.includes(candidateStrategy)) return false;
  // If topic matches perfectly AND sentiment appears aligned, contradiction risk is high
  var topicMatch = analysis && analysis.topic && candidate.topic &&
                   analysis.topic === candidate.topic;
  var semanticHigh = (candidate.similarity_score || 0) >= 0.85;
  return topicMatch && semanticHigh;
}

// ── Main routing function ─────────────────────────────────────────────────────

/**
 * Determines the generation route for a given top-ranked candidate.
 *
 * @param {Object|null} topCandidate   — top result from rankCandidates(), or null
 * @param {Object}      analysis       — PostAnalyzer output
 * @param {Array<string>} recentReplies — recent reply texts (for anti-repetition)
 * @param {Object}      [thresholds]   — override DEFAULT_ROUTING_THRESHOLDS
 * @returns {Object} { route, reason, candidateUsed, guardsTriggered }
 */
function routeCandidate(topCandidate, analysis, recentReplies, thresholds) {
  var cfg = Object.assign({}, DEFAULT_ROUTING_THRESHOLDS, thresholds || {});

  // No candidates retrieved → always generate from scratch
  if (!topCandidate) {
    return {
      route:            ROUTE.GENERATE,
      reason:           "no_candidates_retrieved",
      candidateUsed:    null,
      guardsTriggered:  [],
    };
  }

  var sim     = typeof topCandidate.similarity_score === "number" ? topCandidate.similarity_score : 0;
  var perf    = typeof topCandidate.performance_score === "number" ? topCandidate.performance_score : 0;
  var recency = typeof topCandidate.recency_score === "number" ? topCandidate.recency_score : 0;
  var novelty = typeof topCandidate.novelty_score === "number" ? topCandidate.novelty_score : 1.0;

  // Below medium band → generate from scratch regardless
  if (sim < cfg.MEDIUM_BAND_LOW) {
    return {
      route:           ROUTE.GENERATE,
      reason:          "similarity_below_medium_band:" + sim.toFixed(3),
      candidateUsed:   null,
      guardsTriggered: [],
    };
  }

  // Mid-band → always inspire (no further guard checks needed for inspire path)
  if (sim >= cfg.MEDIUM_BAND_LOW && sim < cfg.HIGH_CONFIDENCE_SIMILARITY) {
    return {
      route:           ROUTE.INSPIRE,
      reason:          "similarity_in_medium_band:" + sim.toFixed(3),
      candidateUsed:   topCandidate,
      guardsTriggered: [],
    };
  }

  // ≥ HIGH_CONFIDENCE — run all ADAPT guards
  var guardsTriggered = [];

  // Guard 1: Performance
  if (perf < cfg.MIN_PERFORMANCE_SCORE) {
    guardsTriggered.push("low_performance:" + perf.toFixed(3));
  }

  // Guard 2: Staleness
  var stalenessResult = checkStaleness(topCandidate, cfg.MAX_STALENESS_DAYS);
  if (stalenessResult.stale) {
    guardsTriggered.push("stale:" + stalenessResult.reason);
  }

  // Guard 3: Contradiction risk
  if (mayContradictCurrentPost(topCandidate, analysis)) {
    guardsTriggered.push("contradiction_risk:strategy=" + topCandidate.reply_strategy);
  }

  // Guard 4: Anti-repetition (too similar to a recently-posted reply)
  if (isTooSimilarToRecent(topCandidate.reply_text, recentReplies || [], cfg.RECENTLY_POSTED_SIMILARITY)) {
    guardsTriggered.push("too_similar_to_recent");
  }

  // Guard 5: Novelty floor (candidate lacks diversity from current ranked set)
  if (novelty < cfg.NOVELTY_FLOOR) {
    guardsTriggered.push("low_novelty:" + novelty.toFixed(3));
  }

  // Guard 6: Recency floor
  if (recency < cfg.RECENCY_FLOOR) {
    guardsTriggered.push("low_recency:" + recency.toFixed(3));
  }

  // Any guard triggered → fall back to INSPIRE (not GENERATE — candidate still has signal)
  if (guardsTriggered.length > 0) {
    return {
      route:           ROUTE.INSPIRE,
      reason:          "adapt_guards_triggered",
      candidateUsed:   topCandidate,
      guardsTriggered: guardsTriggered,
    };
  }

  // All guards cleared → ADAPT
  return {
    route:           ROUTE.ADAPT,
    reason:          "high_confidence_all_guards_cleared:sim=" + sim.toFixed(3),
    candidateUsed:   topCandidate,
    guardsTriggered: [],
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ROUTE,
    DEFAULT_ROUTING_THRESHOLDS,
    checkStaleness,
    isTooSimilarToRecent,
    mayContradictCurrentPost,
    routeCandidate,
  };
}
