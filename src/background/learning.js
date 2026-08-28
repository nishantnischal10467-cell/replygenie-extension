// src/background/learning.js
// Phase 9 — Performance Collection & Learning Loop
//
// Components:
//   1. DOM Scraper Selectors & Health Check (dom_analytics, metrics_confidence, LIKELY_SCRAPER_BREAKAGE)
//   2. Scheduled Collection Cadence (~1hr, ~6hr, ~24hr, ~72hr)
//   3. Performance Classification with Confidence Filter
//   4. PatternMiner (OUTSTANDING / MODERATE / BASELINE structural concept mining)
//   5. Negative Pattern Extraction (Failure taxonomy avoidance signals)
//   6. Ranking Weight Proposal Engine (Proposed vs. Applied weight logging)
//   7. Voice Profile Retraining trigger

/* eslint-disable no-var */

var LEARNING_MODULE_VERSION = "learning-loop-v1.0.0";

// ── 1. DOM Analytics Selectors & Scraper Health ───────────────────────────────

/**
 * X/Twitter Web DOM Selectors for Analytics & Engagement Scrapes.
 * NOTE: These target the account owner's own replies in native timeline views.
 * Source-post / other-user impression data is far less reliable and may not be present.
 */
var X_DOM_SELECTORS = {
  tweetArticle:   'article[data-testid="tweet"]',
  tweetText:      '[data-testid="tweetText"]',
  // Metrics container and buttons
  replyCount:     '[data-testid="reply"] span',
  repostCount:    '[data-testid="retweet"] span, [data-testid="unretweet"] span',
  likeCount:      '[data-testid="like"] span, [data-testid="unlike"] span',
  bookmarkCount:  '[data-testid="bookmark"] span',
  // Views / Analytics button and tooltips
  analyticsLink:  'a[href*="/analytics"]',
  viewsContainer: '[data-testid="app-text-transition-container"]',
  viewsAria:      '[aria-label*="views" i], [aria-label*="Analytics" i], [aria-label*="view post analytics" i]',
};

var METRICS_CONFIDENCE = {
  FRESH:      "fresh",      // Successfully scraped with expected DOM elements populated
  STALE:      "stale",      // Older scrape unchanged across collection intervals
  MISSING:    "missing",    // Expected metric elements not present in DOM
  UNRELIABLE: "unreliable", // Found blank or inconsistent numerical values
};

var SCRAPER_HEALTH_THRESHOLDS = {
  max_zero_ratio: 0.70,     // If >70% of tracked replies return 0/null, flag scraper breakage
  min_sample_size: 5,       // Minimum sample count required before evaluating zero ratio
};

/**
 * Parses raw text representation of numbers from X DOM (e.g. "1.2K", "45", "10M").
 * @param {string} rawText
 * @returns {number}
 */
function parseXMetricNumber(rawText) {
  if (!rawText || typeof rawText !== "string") return 0;
  var clean = rawText.trim().toUpperCase().replace(/,/g, "");
  if (!clean) return 0;

  if (clean.endsWith("K")) {
    return Math.round(parseFloat(clean.slice(0, -1)) * 1000) || 0;
  }
  if (clean.endsWith("M")) {
    return Math.round(parseFloat(clean.slice(0, -1)) * 1000000) || 0;
  }
  var num = parseInt(clean, 10);
  return isNaN(num) ? 0 : num;
}

/**
 * Checks scraper health across a batch of scraped replies.
 * Flags LIKELY_SCRAPER_BREAKAGE if an abnormal proportion of reads return zero/null.
 *
 * @param {Array<Object>} batchResults - array of { reply_id, impressions, metrics_confidence }
 * @param {Object} [thresholds]
 * @returns {{ isHealthy: boolean, zeroRatio: number, alert: string|null }}
 */
function checkScraperHealth(batchResults, thresholds) {
  thresholds = Object.assign({}, SCRAPER_HEALTH_THRESHOLDS, thresholds || {});
  if (!Array.isArray(batchResults) || batchResults.length < thresholds.min_sample_size) {
    return { isHealthy: true, zeroRatio: 0, alert: null };
  }

  var zeroOrMissingCount = 0;
  batchResults.forEach(function (res) {
    var isZero = !res.impressions || res.impressions === 0;
    var isMissing = res.metrics_confidence === METRICS_CONFIDENCE.MISSING ||
                    res.metrics_confidence === METRICS_CONFIDENCE.UNRELIABLE;
    if (isZero || isMissing) zeroOrMissingCount++;
  });

  var zeroRatio = zeroOrMissingCount / batchResults.length;
  var isHealthy = zeroRatio < thresholds.max_zero_ratio;

  return {
    isHealthy: isHealthy,
    zeroRatio: Number(zeroRatio.toFixed(3)),
    alert: isHealthy ? null : "LIKELY_SCRAPER_BREAKAGE: " + Math.round(zeroRatio * 100) + "% of scraped replies returned zero/missing impressions.",
  };
}

// ── 2. Scheduled Metrics Collection Cadence ──────────────────────────────────

var COLLECTION_CADENCE_HOURS = [1, 6, 24, 72]; // Intervals in hours after post creation

/**
 * Determines whether a reply is due for its next scheduled metrics scrape.
 *
 * @param {Object} replyRecord - { created_at, last_scraped_at, scrape_count }
 * @param {number} [nowMs]
 * @returns {{ isDue: boolean, targetIntervalHours: number, scrapeCount: number }}
 */
function isScrapeDue(replyRecord, nowMs) {
  if (!replyRecord || !replyRecord.created_at) {
    return { isDue: false, targetIntervalHours: 0, scrapeCount: 0 };
  }

  nowMs = nowMs || Date.now();
  var createdMs = new Date(replyRecord.created_at).getTime();
  var ageHours  = (nowMs - createdMs) / (1000 * 60 * 60);
  var scrapeCount = typeof replyRecord.scrape_count === "number" ? replyRecord.scrape_count : 0;

  // Past 72hr lifecycle — no further scheduled scrapes needed
  if (scrapeCount >= COLLECTION_CADENCE_HOURS.length) {
    return { isDue: false, targetIntervalHours: 72, scrapeCount: scrapeCount };
  }

  var targetInterval = COLLECTION_CADENCE_HOURS[scrapeCount];
  var isDue = ageHours >= targetInterval;

  return {
    isDue: isDue,
    targetIntervalHours: targetInterval,
    scrapeCount: scrapeCount,
  };
}

// ── 3. Performance Classification with Confidence Filter ─────────────────────

/**
 * Reclassifies reply performance class (OUTSTANDING / MODERATE / BASELINE)
 * ONLY if metrics confidence is acceptable.
 *
 * @param {Object} replyRecord - { impressions, likes, replies, reposts, metrics_confidence }
 * @param {number} [sourcePostImpressions] - impressions of the parent tweet for ratio normalization
 * @param {Object} [rankerModule] - Phase 4 ranker functions
 * @returns {{ performanceClass: string, performanceScore: number, skippedReason: string|null }}
 */
function classifyWithConfidence(replyRecord, sourcePostImpressions, rankerModule) {
  if (!replyRecord) {
    return { performanceClass: "baseline", performanceScore: 0, skippedReason: "null_record" };
  }

  var conf = replyRecord.metrics_confidence || METRICS_CONFIDENCE.FRESH;

  // Confidence Filter: Exclude missing or unreliable data from feeding the learning loop
  if (conf === METRICS_CONFIDENCE.MISSING || conf === METRICS_CONFIDENCE.UNRELIABLE) {
    return {
      performanceClass: replyRecord.performance_class || "baseline",
      performanceScore: replyRecord.performance_score || 0,
      skippedReason: "unreliable_metrics_confidence:" + conf,
    };
  }

  var impressions = replyRecord.impressions || 0;
  var likes = replyRecord.likes || 0;
  var replies = replyRecord.replies || 0;
  var reposts = replyRecord.reposts || 0;

  var ratio = (sourcePostImpressions && sourcePostImpressions > 0)
    ? (impressions / sourcePostImpressions)
    : null;

  var classifyFn = (rankerModule && rankerModule.classifyPerformance)
    ? rankerModule.classifyPerformance
    : function (imp) {
        if (imp >= 10000) return "outstanding";
        if (imp >= 500)   return "moderate";
        return "baseline";
      };

  var perfClass = classifyFn(impressions, ratio);

  // Composite normalized score
  var rawScore = (impressions * 0.0001) + (likes * 0.05) + (replies * 0.10) + (reposts * 0.15);
  var performanceScore = Math.max(0, Math.min(1.0, rawScore));

  return {
    performanceClass: perfClass,
    performanceScore: Number(performanceScore.toFixed(3)),
    skippedReason: null,
  };
}

// ── 4. PatternMiner — Concept & Structural Feature Extraction ─────────────────

/**
 * Extracts conceptual features from a reply text.
 * @param {string} text
 * @returns {Object}
 */
function extractConceptFeatures(text) {
  if (!text) return { hook_type: "observation", specificity: 0.3, contrarian_level: 0, humor_level: 0, technical_depth: 0, numbers_present: false, personal_experience: false, question_present: false, sentence_count: 1 };

  var trimmed = text.trim();
  var sentences = trimmed.split(/[.!?\n]+/).filter(function (s) { return s.trim().length > 0; });
  var sentenceCount = Math.max(1, sentences.length);

  var hasNumbers = /\b\d+(?:[.,]\d+)?\b/.test(trimmed);
  var hasPersonalExp = /\b(i|my|we|our|me|us)\b/i.test(trimmed);
  var hasQuestion = /\?/.test(trimmed);

  // Hook classification
  var hookType = "observation";
  if (hasQuestion && trimmed.endsWith("?")) hookType = "question";
  else if (hasNumbers) hookType = "data_point";
  else if (hasPersonalExp) hookType = "personal_experience";
  else if (/\b(however|but|actually|contrary|disagree|wrong)\b/i.test(trimmed)) hookType = "contrarian_take";

  // Specificity score (0.0 to 1.0)
  var specScore = 0.3;
  if (hasNumbers) specScore += 0.3;
  if (/[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}/.test(trimmed)) specScore += 0.2; // Proper nouns
  if (/\b(because|specifically|e\.g\.|due to)\b/i.test(trimmed)) specScore += 0.2;
  specScore = Math.min(1.0, specScore);

  // Contrarian level (0.0 to 1.0)
  var contrarianLevel = /\b(however|but|though|except|unless|instead|contrary)\b/i.test(trimmed) ? 0.7 : 0.1;

  // Humor level
  var humorLevel = /\b(lol|haha|lmao)\b/i.test(trimmed) || /😅|😂|💀/.test(trimmed) ? 0.8 : 0.0;

  // Technical depth
  var techKeywords = ["api", "sql", "db", "latency", "redis", "postgres", "cache", "monolith", "grpc", "saas", "mrr", "k8s", "docker", "p99"];
  var techMatchCount = 0;
  techKeywords.forEach(function (k) {
    if (new RegExp("\\b" + k + "\\b", "i").test(trimmed)) techMatchCount++;
  });
  var techDepth = Math.min(1.0, techMatchCount * 0.3);

  return {
    hook_type:           hookType,
    specificity:         specScore,
    contrarian_level:    contrarianLevel,
    humor_level:         humorLevel,
    technical_depth:     techDepth,
    numbers_present:     hasNumbers,
    personal_experience: hasPersonalExp,
    question_present:    hasQuestion,
    sentence_count:      sentenceCount,
  };
}

/**
 * Mines structural and conceptual patterns across classified reply buckets.
 * Discovers what distinguishes successful replies for THIS ACCOUNT.
 *
 * @param {Array<Object>} classifiedReplies - array of { id, reply_text, performance_class, strategy, topic, impressions }
 * @returns {Object} mined patterns and synthesized conceptual takeaways
 */
function minePatterns(classifiedReplies) {
  classifiedReplies = Array.isArray(classifiedReplies) ? classifiedReplies : [];

  var buckets = {
    outstanding: [],
    moderate:    [],
    baseline:    [],
  };

  classifiedReplies.forEach(function (r) {
    var pClass = (r.performance_class || "baseline").toLowerCase();
    if (buckets[pClass]) {
      buckets[pClass].push(r);
    } else {
      buckets.baseline.push(r);
    }
  });

  function aggregateBucketStats(items) {
    if (items.length === 0) {
      return { count: 0, avgSpecificity: 0, dataPointRate: 0, questionRate: 0, contrarianRate: 0, personalExpRate: 0, techDepth: 0 };
    }

    var totalSpec = 0;
    var dataPointCount = 0;
    var questionCount = 0;
    var contrarianCount = 0;
    var personalExpCount = 0;
    var totalTech = 0;

    items.forEach(function (item) {
      var text = item.reply_text || item.text || "";
      var feat = extractConceptFeatures(text);
      totalSpec += feat.specificity;
      if (feat.numbers_present) dataPointCount++;
      if (feat.question_present) questionCount++;
      if (feat.contrarian_level > 0.5) contrarianCount++;
      if (feat.personal_experience) personalExpCount++;
      totalTech += feat.technical_depth;
    });

    var count = items.length;
    return {
      count: count,
      avgSpecificity:   Number((totalSpec / count).toFixed(2)),
      dataPointRate:    Number((dataPointCount / count).toFixed(2)),
      questionRate:     Number((questionCount / count).toFixed(2)),
      contrarianRate:   Number((contrarianCount / count).toFixed(2)),
      personalExpRate:  Number((personalExpCount / count).toFixed(2)),
      avgTechDepth:     Number((totalTech / count).toFixed(2)),
    };
  }

  var stats = {
    outstanding: aggregateBucketStats(buckets.outstanding),
    moderate:    aggregateBucketStats(buckets.moderate),
    baseline:    aggregateBucketStats(buckets.baseline),
  };

  // Synthesize conceptual insights
  var conceptualInsights = [];

  if (stats.outstanding.count > 0) {
    if (stats.outstanding.dataPointRate > stats.baseline.dataPointRate + 0.20) {
      conceptualInsights.push("Replies citing specific data points or metrics outperform qualitative observations by " + Math.round(stats.outstanding.dataPointRate * 100) + "%.");
    }
    if (stats.outstanding.questionRate < stats.baseline.questionRate - 0.20) {
      conceptualInsights.push("Declarative insights strongly outperform question-ending replies for this account.");
    }
    if (stats.outstanding.avgTechDepth > stats.baseline.avgTechDepth + 0.20) {
      conceptualInsights.push("Concrete technical depth and architectural tradeoffs drive higher engagement than high-level commentary.");
    }
    if (stats.outstanding.contrarianRate > stats.baseline.contrarianRate + 0.15) {
      conceptualInsights.push("Polite contrarian reframing is a high-yield strategy for this audience.");
    }
  }

  if (conceptualInsights.length === 0) {
    conceptualInsights.push("Baseline performance established — awaiting further classified metrics.");
  }

  return {
    sampleSize: classifiedReplies.length,
    bucketStats: stats,
    conceptualInsights: conceptualInsights,
    mined_at: new Date().toISOString(),
  };
}

// ── 5. Negative Pattern Extraction ───────────────────────────────────────────

/**
 * Extracts negative signals from manual rejections (Phase 7) and baseline failures.
 *
 * @param {Array<Object>} rejections - array of { failure_tag, reply_text, strategy }
 * @returns {{ failureTagDistribution: Object, topAvoidanceDirectives: Array<string> }}
 */
function extractNegativePatterns(rejections) {
  rejections = Array.isArray(rejections) ? rejections : [];
  var tagCounts = {};

  rejections.forEach(function (rej) {
    var tag = rej.failure_tag || "GENERIC";
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  });

  var sortedTags = Object.keys(tagCounts).sort(function (a, b) {
    return tagCounts[b] - tagCounts[a];
  });

  var directives = [];
  sortedTags.slice(0, 4).forEach(function (tag) {
    if (tag === "GENERIC") {
      directives.push("AVOID: Hollow affirmations, obvious agreement, or statements applicable to unrelated tweets.");
    } else if (tag === "FORCED_QUESTION") {
      directives.push("AVOID: Appending trailing engagement-bait questions ('Thoughts?', 'Agree?').");
    } else if (tag === "UNSUPPORTED_CLAIM") {
      directives.push("AVOID: Unverified statistics or fabricated case studies not present in source context.");
    } else if (tag === "TOO_AGREEABLE") {
      directives.push("AVOID: Pure sycophantic praise ('Great post!', 'Love this!').");
    } else if (tag === "COPIED_STRUCTURE") {
      directives.push("AVOID: Re-using identical syntactic openers across consecutive replies.");
    } else {
      directives.push("AVOID: Pattern tag " + tag);
    }
  });

  return {
    rejectionCount: rejections.length,
    failureTagDistribution: tagCounts,
    topAvoidanceDirectives: directives,
  };
}

// ── 6. Ranking Weight Proposal Engine ─────────────────────────────────────────

var WEIGHT_PROPOSALS_KEY = "weightProposals";

/**
 * Generates proposed adjustments to Phase 4 ranking weights based on mined patterns.
 * Ground rule: NEVER auto-mutate production weights silently. Log proposed vs. applied.
 *
 * @param {Object} patternMiningResult - output of minePatterns()
 * @param {Object} currentWeights - current Phase 4 weights (DEFAULT_WEIGHTS)
 * @returns {Object} proposal record { id, proposed_weights, current_weights, rationale, status: "proposed" }
 */
function proposeRankingWeightAdjustments(patternMiningResult, currentWeights) {
  currentWeights = currentWeights || {
    semantic_similarity: 0.30,
    topic_similarity:    0.15,
    strategy_match:      0.15,
    performance_score:   0.20,
    voice_similarity:    0.10,
    recency_score:       0.05,
    novelty_score:       0.05,
  };

  var stats = (patternMiningResult && patternMiningResult.bucketStats) || {};
  var out = stats.outstanding || {};
  var base = stats.baseline || {};

  var proposed = Object.assign({}, currentWeights);
  var rationales = [];

  // If outstanding replies correlate heavily with high data points / technical depth,
  // boost performance_score and strategy_match
  if (out.count >= 5 && out.dataPointRate > (base.dataPointRate || 0)) {
    proposed.performance_score = Number((proposed.performance_score + 0.05).toFixed(2));
    proposed.semantic_similarity = Number((proposed.semantic_similarity - 0.05).toFixed(2));
    rationales.push("Increased performance_score weight (+0.05) due to strong performance signal correlation in OUTSTANDING bucket.");
  }

  if (out.count >= 5 && out.avgTechDepth > (base.avgTechDepth || 0)) {
    proposed.strategy_match = Number((proposed.strategy_match + 0.05).toFixed(2));
    proposed.recency_score = Math.max(0.02, Number((proposed.recency_score - 0.05).toFixed(2)));
    rationales.push("Increased strategy_match weight (+0.05) due to high strategy-specific retention.");
  }

  // Normalize proposed weights so they sum to 1.0
  var sum = Object.values(proposed).reduce(function (a, b) { return a + b; }, 0);
  if (sum > 0 && Math.abs(sum - 1.0) > 0.01) {
    Object.keys(proposed).forEach(function (k) {
      proposed[k] = Number((proposed[k] / sum).toFixed(3));
    });
  }

  var proposalId = "prop_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  var proposal = {
    id:               proposalId,
    created_at:       new Date().toISOString(),
    status:           "proposed", // "proposed" | "approved" | "rejected"
    current_weights:  currentWeights,
    proposed_weights: proposed,
    rationale:        rationales.length > 0 ? rationales.join("; ") : "No significant weight divergence detected.",
    sample_size:      (patternMiningResult && patternMiningResult.sampleSize) || 0,
  };

  // Buffer proposal in chrome.storage.local for operator review
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ [WEIGHT_PROPOSALS_KEY]: [] }, function (data) {
        var list = Array.isArray(data[WEIGHT_PROPOSALS_KEY]) ? data[WEIGHT_PROPOSALS_KEY] : [];
        list.push(proposal);
        var update = {};
        update[WEIGHT_PROPOSALS_KEY] = list.slice(-50);
        chrome.storage.local.set(update, function () {});
      });
    }
  } catch (_) {}

  return proposal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    LEARNING_MODULE_VERSION,
    X_DOM_SELECTORS,
    METRICS_CONFIDENCE,
    SCRAPER_HEALTH_THRESHOLDS,
    COLLECTION_CADENCE_HOURS,
    parseXMetricNumber,
    checkScraperHealth,
    isScrapeDue,
    classifyWithConfidence,
    extractConceptFeatures,
    minePatterns,
    extractNegativePatterns,
    proposeRankingWeightAdjustments,
    WEIGHT_PROPOSALS_KEY,
  };
}
