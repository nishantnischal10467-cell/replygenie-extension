// src/background/analytics.js
// Phase 10 — Analytics Dashboard Data Layer
//
// Computes and aggregates high-fidelity performance metrics across the entire
// reply lifecycle, generation mix, quality rejections, rankings, and Qualified
// Conversation Rate (QCR).
//
// Metrics provided:
//   1. Generation Mix: total replies, reuse rate, adaptation rate, AI generation rate
//   2. Impressions & Distribution: average impressions, median impressions, moderate/outstanding count
//   3. Engagement & Interactions: average engagement rate, author reply rate, profile visit rate
//   4. Behavioral: question rate
//   5. Quality & Rejections: genericity rejection rate, accuracy rejection rate, duplicate rejection rate
//   6. Rankings: top 20 replies, worst 20 replies, top 20 patterns, top/worst strategies, top/worst topics
//   7. Qualified Conversation Rate (QCR):
//        QCR = (author_replies + meaningful_user_replies + profile_visits + attributable_follows) / impressions

/* eslint-disable no-var */

var ANALYTICS_MODULE_VERSION = "analytics-v1.0.0";

// ── Math & Statistical Helpers ────────────────────────────────────────────────

/**
 * Calculates the median of an array of numbers.
 * @param {Array<number>} numbers
 * @returns {number}
 */
function calculateMedian(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return 0;
  var sorted = numbers.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Calculates arithmetic mean of an array of numbers.
 * @param {Array<number>} numbers
 * @returns {number}
 */
function calculateMean(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return 0;
  var sum = numbers.reduce(function (a, b) { return a + b; }, 0);
  return Number((sum / numbers.length).toFixed(2));
}

// ── Core Dashboard Analytics Aggregator ───────────────────────────────────────

/**
 * Aggregates all dashboard analytics from historical replies, patterns, and rejections.
 *
 * @param {Array<Object>} storedReplies - array of reply records from IndexedDB
 * @param {Array<Object>} [manualRejections] - array of rejection records from storage
 * @param {Array<Object>} [reviewQueueItems] - array of queued failed evaluations
 * @returns {Object} complete analytics payload
 */
function aggregateDashboardMetrics(storedReplies, manualRejections, reviewQueueItems) {
  storedReplies    = Array.isArray(storedReplies) ? storedReplies : [];
  manualRejections = Array.isArray(manualRejections) ? manualRejections : [];
  reviewQueueItems = Array.isArray(reviewQueueItems) ? reviewQueueItems : [];

  var totalReplies = storedReplies.length;

  // 1. Generation Mix
  var reusedCount   = 0;
  var adaptedCount  = 0;
  var aiGenCount    = 0;
  var humanCount    = 0;

  // 2. Impressions & Performance Classes
  var allImpressions = [];
  var outstandingCount = 0;
  var moderateCount    = 0;
  var baselineCount    = 0;

  // 3. Engagement & Interactions
  var totalImpressions = 0;
  var totalLikes       = 0;
  var totalRepliesRecv = 0;
  var totalReposts     = 0;
  var totalBookmarks   = 0;
  var authorReplyCount = 0;
  var profileVisitSum  = 0;

  // 4. Behavioral
  var questionCount    = 0;

  // 5. Qualified Conversation Rate Components
  var totalMeaningfulReplies = 0;
  var totalAttributableFollows = 0;

  storedReplies.forEach(function (r) {
    // Generation Mix
    if (r.is_reused)        reusedCount++;
    if (r.is_adapted)       adaptedCount++;
    if (r.is_ai_generated)  aiGenCount++;
    if (r.is_human_written) humanCount++;

    // Impressions & Class
    var imp = typeof r.impressions === "number" ? r.impressions : 0;
    allImpressions.push(imp);
    totalImpressions += imp;

    var pClass = (r.performance_class || "baseline").toLowerCase();
    if (pClass === "outstanding") outstandingCount++;
    else if (pClass === "moderate") moderateCount++;
    else baselineCount++;

    // Engagements
    totalLikes       += (typeof r.likes === "number" ? r.likes : 0);
    totalRepliesRecv += (typeof r.replies === "number" ? r.replies : 0);
    totalReposts     += (typeof r.reposts === "number" ? r.reposts : 0);
    totalBookmarks   += (typeof r.bookmarks === "number" ? r.bookmarks : 0);

    if (r.author_replied || (r.author_response && r.author_response === 1)) {
      authorReplyCount++;
    }

    var pv = typeof r.profile_visits === "number" ? r.profile_visits : 0;
    profileVisitSum += pv;

    // Behavioral
    var text = r.reply_text || "";
    if (/\?/.test(text)) questionCount++;

    // Qualified Conversation components
    var meaningful = typeof r.meaningful_user_replies === "number"
      ? r.meaningful_user_replies
      : Math.floor((typeof r.replies === "number" ? r.replies : 0) * 0.5); // conservative estimate
    totalMeaningfulReplies += meaningful;

    var follows = typeof r.attributable_follows === "number" ? r.attributable_follows : 0;
    totalAttributableFollows += follows;
  });

  var safeTotal = totalReplies > 0 ? totalReplies : 1;
  var safeImp   = totalImpressions > 0 ? totalImpressions : 1;

  // Generation Mix Rates
  var reuseRate     = Number((reusedCount / safeTotal).toFixed(3));
  var adaptationRate = Number((adaptedCount / safeTotal).toFixed(3));
  var aiGenRate     = Number((aiGenCount / safeTotal).toFixed(3));
  var humanRate     = Number((humanCount / safeTotal).toFixed(3));

  // Impression Distribution
  var avgImpressions    = calculateMean(allImpressions);
  var medianImpressions = calculateMedian(allImpressions);

  // Engagement Rates
  var totalEngagements = totalLikes + totalRepliesRecv + totalReposts + totalBookmarks;
  var avgEngagementRate = Number((totalEngagements / safeImp).toFixed(4));
  var authorReplyRate   = Number((authorReplyCount / safeTotal).toFixed(4));
  var profileVisitRate  = Number((profileVisitSum / safeImp).toFixed(4));

  // Behavioral
  var questionRate = Number((questionCount / safeTotal).toFixed(3));

  // 6. Quality & Rejection Rates
  var totalRejections = manualRejections.length;
  var genericityRejects = 0;
  var accuracyRejects   = 0;
  var duplicateRejects  = 0;
  var forcedQuestionRejects = 0;

  manualRejections.forEach(function (rej) {
    var tag = rej.failure_tag || "";
    if (tag === "GENERIC")           genericityRejects++;
    if (tag === "UNSUPPORTED_CLAIM") accuracyRejects++;
    if (tag === "REPETITIVE")        duplicateRejects++;
    if (tag === "FORCED_QUESTION")   forcedQuestionRejects++;
  });

  var totalEvaluatedSamples = totalReplies + totalRejections;
  var safeEval = totalEvaluatedSamples > 0 ? totalEvaluatedSamples : 1;

  var genericityRejectionRate = Number((genericityRejects / safeEval).toFixed(4));
  var accuracyRejectionRate   = Number((accuracyRejects / safeEval).toFixed(4));
  var duplicateRejectionRate  = Number((duplicateRejects / safeEval).toFixed(4));

  // 7. Qualified Conversation Rate (QCR)
  // QCR = (author_replies + meaningful_user_replies + profile_visits + attributable_follows) / impressions
  var qualifiedEvents = authorReplyCount + totalMeaningfulReplies + profileVisitSum + totalAttributableFollows;
  var qualifiedConversationRate = Number((qualifiedEvents / safeImp).toFixed(4));

  return {
    version: ANALYTICS_MODULE_VERSION,
    calculated_at: new Date().toISOString(),

    // Generation Mix
    generation_mix: {
      total_replies:              totalReplies,
      database_reuse_count:       reusedCount,
      database_reuse_rate:        reuseRate,
      database_adaptation_count:  adaptedCount,
      database_adaptation_rate:   adaptationRate,
      ai_generation_count:        aiGenCount,
      ai_generation_rate:         aiGenRate,
      human_written_count:        humanCount,
      human_written_rate:         humanRate,
    },

    // Impression Distribution
    impressions: {
      total:                     totalImpressions,
      average:                   avgImpressions,
      median:                    medianImpressions,
      outstanding_count:         outstandingCount,
      moderate_count:            moderateCount,
      baseline_count:            baselineCount,
    },

    // Engagement & Interactions
    engagement: {
      average_engagement_rate:   avgEngagementRate,
      total_engagements:         totalEngagements,
      author_reply_count:        authorReplyCount,
      author_reply_rate:         authorReplyRate,
      profile_visit_count:       profileVisitSum,
      profile_visit_rate:        profileVisitRate,
      total_likes:               totalLikes,
      total_replies_received:    totalRepliesRecv,
      total_reposts:             totalReposts,
      total_bookmarks:           totalBookmarks,
    },

    // Behavioral
    behavioral: {
      question_count:            questionCount,
      question_rate:             questionRate,
    },

    // Quality & Rejections
    quality_gate: {
      total_rejections_recorded: totalRejections,
      review_queue_pending:      reviewQueueItems.length,
      genericity_rejection_rate: genericityRejectionRate,
      accuracy_rejection_rate:   accuracyRejectionRate,
      duplicate_rejection_rate:  duplicateRejectionRate,
      genericity_rejects:        genericityRejects,
      accuracy_rejects:          accuracyRejects,
      duplicate_rejects:         duplicateRejects,
      forced_question_rejects:   forcedQuestionRejects,
    },

    // Qualified Conversation Rate (QCR) — computed & shown separately from raw impressions
    qualified_conversation: {
      qualified_conversation_rate: qualifiedConversationRate,
      total_qualified_events:      qualifiedEvents,
      author_replies:              authorReplyCount,
      meaningful_user_replies:     totalMeaningfulReplies,
      profile_visits:              profileVisitSum,
      attributable_follows:        totalAttributableFollows,
      formula:                     "(author_replies + meaningful_user_replies + profile_visits + attributable_follows) / total_impressions",
    },
  };
}

// ── Top & Worst Rankings Query Engine ─────────────────────────────────────────

/**
 * Computes top 20 replies, worst 20 replies, top/worst strategies, top/worst topics,
 * and top 20 reply patterns.
 *
 * @param {Array<Object>} storedReplies - array of reply records from IndexedDB
 * @param {Array<Object>} [storedPatterns] - array of pattern records from IndexedDB
 * @returns {Object} rankings payload
 */
function computeRankingsAndBreakdowns(storedReplies, storedPatterns) {
  storedReplies  = Array.isArray(storedReplies) ? storedReplies : [];
  storedPatterns = Array.isArray(storedPatterns) ? storedPatterns : [];

  // 1. Top 20 Replies (sorted by performance_score descending, then impressions)
  var top20Replies = storedReplies.slice().sort(function (a, b) {
    var scoreA = typeof a.performance_score === "number" ? a.performance_score : 0;
    var scoreB = typeof b.performance_score === "number" ? b.performance_score : 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (b.impressions || 0) - (a.impressions || 0);
  }).slice(0, 20);

  // 2. Worst 20 Replies (sorted by performance_score ascending, baseline first)
  var worst20Replies = storedReplies.slice().sort(function (a, b) {
    var scoreA = typeof a.performance_score === "number" ? a.performance_score : 0;
    var scoreB = typeof b.performance_score === "number" ? b.performance_score : 0;
    if (scoreA !== scoreB) return scoreA - scoreB;
    return (a.impressions || 0) - (b.impressions || 0);
  }).slice(0, 20);

  // 3. Top 20 Reply Patterns
  var top20Patterns = storedPatterns.slice().sort(function (a, b) {
    var engA = typeof a.engagement_rate === "number" ? a.engagement_rate : 0;
    var engB = typeof b.engagement_rate === "number" ? b.engagement_rate : 0;
    if (engB !== engA) return engB - engA;
    return (b.impressions || 0) - (a.impressions || 0);
  }).slice(0, 20);

  // 4. Strategy Performance Breakdown
  var strategyMap = {};
  storedReplies.forEach(function (r) {
    var strat = r.reply_strategy || "default";
    if (!strategyMap[strat]) {
      strategyMap[strat] = { count: 0, totalImpressions: 0, totalScore: 0, totalQcrEvents: 0 };
    }
    var imp = typeof r.impressions === "number" ? r.impressions : 0;
    var score = typeof r.performance_score === "number" ? r.performance_score : 0;
    var qcrEvents = (r.author_replied ? 1 : 0) + (r.profile_visits || 0);

    strategyMap[strat].count++;
    strategyMap[strat].totalImpressions += imp;
    strategyMap[strat].totalScore += score;
    strategyMap[strat].totalQcrEvents += qcrEvents;
  });

  var strategyList = Object.keys(strategyMap).map(function (strat) {
    var d = strategyMap[strat];
    return {
      strategy:         strat,
      sample_count:     d.count,
      avg_impressions:  Math.round(d.totalImpressions / d.count),
      avg_score:        Number((d.totalScore / d.count).toFixed(3)),
      total_qcr_events: d.totalQcrEvents,
    };
  });

  var topStrategies   = strategyList.slice().sort(function (a, b) { return b.avg_score - a.avg_score; }).slice(0, 3);
  var worstStrategies = strategyList.slice().sort(function (a, b) { return a.avg_score - b.avg_score; }).slice(0, 3);

  // 5. Topic Performance Breakdown
  var topicMap = {};
  storedReplies.forEach(function (r) {
    var topic = r.topic || "general";
    if (!topicMap[topic]) {
      topicMap[topic] = { count: 0, totalImpressions: 0, totalScore: 0 };
    }
    topicMap[topic].count++;
    topicMap[topic].totalImpressions += (typeof r.impressions === "number" ? r.impressions : 0);
    topicMap[topic].totalScore       += (typeof r.performance_score === "number" ? r.performance_score : 0);
  });

  var topicList = Object.keys(topicMap).map(function (top) {
    var d = topicMap[top];
    return {
      topic:           top,
      sample_count:    d.count,
      avg_impressions: Math.round(d.totalImpressions / d.count),
      avg_score:       Number((d.totalScore / d.count).toFixed(3)),
    };
  });

  var topTopics   = topicList.slice().sort(function (a, b) { return b.avg_score - a.avg_score; }).slice(0, 3);
  var worstTopics = topicList.slice().sort(function (a, b) { return a.avg_score - b.avg_score; }).slice(0, 3);

  return {
    top_20_replies:       top20Replies,
    worst_20_replies:     worst20Replies,
    top_20_patterns:      top20Patterns,
    strategy_breakdown:   strategyList,
    top_strategies:       topStrategies,
    worst_strategies:     worstStrategies,
    topic_breakdown:      topicList,
    top_topics:           topTopics,
    worst_topics:         worstTopics,
  };
}

// ── Database Analytics Query Runner ───────────────────────────────────────────

/**
 * Loads database data and returns the full analytics suite.
 * Queryable from background message handlers.
 *
 * @param {Object} [databaseLayer] - optional mock/injected database module
 * @returns {Promise<Object>} complete analytics suite
 */
async function queryFullAnalyticsSuite(databaseLayer) {
  var dbRepo = databaseLayer || (typeof repliesRepo !== "undefined" ? {
    repliesRepo: repliesRepo,
    replyPatternsRepo: typeof replyPatternsRepo !== "undefined" ? replyPatternsRepo : null,
  } : null);

  var storedReplies = [];
  var storedPatterns = [];
  var manualRejections = [];
  var reviewQueueItems = [];

  if (dbRepo && dbRepo.repliesRepo && dbRepo.repliesRepo.getRecentReplies) {
    try {
      storedReplies = await dbRepo.repliesRepo.getRecentReplies(500);
    } catch (_) {}
  }

  if (dbRepo && dbRepo.replyPatternsRepo && dbRepo.replyPatternsRepo.getPatternsByStrategy) {
    try {
      storedPatterns = await dbRepo.replyPatternsRepo.getPatternsByStrategy("default", 100);
    } catch (_) {}
  }

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      var storeData = await new Promise(function (resolve) {
        chrome.storage.local.get({ manualRejections: [], humanReviewQueue: [] }, resolve);
      });
      manualRejections = storeData.manualRejections || [];
      reviewQueueItems = storeData.humanReviewQueue || [];
    } catch (_) {}
  }

  var dashboardMetrics = aggregateDashboardMetrics(storedReplies, manualRejections, reviewQueueItems);
  var rankings = computeRankingsAndBreakdowns(storedReplies, storedPatterns);

  return {
    metrics:  dashboardMetrics,
    rankings: rankings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ANALYTICS_MODULE_VERSION,
    calculateMedian,
    calculateMean,
    aggregateDashboardMetrics,
    computeRankingsAndBreakdowns,
    queryFullAnalyticsSuite,
  };
}
