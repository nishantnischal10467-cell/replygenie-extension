// src/background/db/schema.js
// Database schema definitions, factories, and store specifications.
// Supports IndexedDB storage for ReplyGenie in MV3 service worker environment.

/* eslint-disable no-var */

var DB_NAME = "ReplyGenieDB";
var DB_VERSION = 1;

var STORES = {
  REPLIES:          "replies",
  VOICE_PROFILES:   "voice_profiles",
  REPLY_PATTERNS:   "reply_patterns",
  GENERATION_RUNS:  "generation_runs",
  RETENTION_META:   "retention_meta",
};

// ── Store Index Specifications ───────────────────────────────────────────────

var STORE_INDEXES = {
  [STORES.REPLIES]: [
    { name: "source_post_id",            keyPath: "source_post_id",            unique: false },
    { name: "source_tweet_author_handle",keyPath: "source_tweet_author_handle",unique: false },
    { name: "created_at",                keyPath: "created_at",                unique: false },
    { name: "last_updated_at",           keyPath: "last_updated_at",           unique: false },
    { name: "topic",                     keyPath: "topic",                     unique: false },
    { name: "intent",                    keyPath: "intent",                    unique: false },
    { name: "reply_strategy",            keyPath: "reply_strategy",            unique: false },
    { name: "is_human_written",          keyPath: "is_human_written",          unique: false },
    { name: "is_ai_generated",           keyPath: "is_ai_generated",           unique: false },
    { name: "generation_run_id",         keyPath: "generation_run_id",         unique: false },
    { name: "generation_prompt_version", keyPath: "generation_prompt_version", unique: false },
    { name: "raw_text_purged",           keyPath: "raw_text_purged",           unique: false },
  ],
  [STORES.VOICE_PROFILES]: [
    { name: "version",                   keyPath: "version",                   unique: true },
    { name: "is_active",                 keyPath: "is_active",                 unique: false },
    { name: "last_trained_at",           keyPath: "last_trained_at",           unique: false },
  ],
  [STORES.REPLY_PATTERNS]: [
    { name: "reply_id",                  keyPath: "reply_id",                  unique: false },
    { name: "strategy",                  keyPath: "strategy",                  unique: false },
    { name: "topic",                     keyPath: "topic",                     unique: false },
    { name: "hook_type",                 keyPath: "hook_type",                 unique: false },
    { name: "question_present",          keyPath: "question_present",          unique: false },
    { name: "author_response",           keyPath: "author_response",           unique: false },
    { name: "created_at",                keyPath: "created_at",                unique: false },
  ],
  [STORES.GENERATION_RUNS]: [
    { name: "timestamp",                 keyPath: "timestamp",                 unique: false },
    { name: "source_post_id",            keyPath: "source_post_id",            unique: false },
    { name: "prompt_version",            keyPath: "prompt_version",            unique: false },
    { name: "model",                     keyPath: "model",                     unique: false },
    { name: "selected_strategy",         keyPath: "selected_strategy",         unique: false },
    { name: "status",                    keyPath: "status",                    unique: false },
  ],
  [STORES.RETENTION_META]: [
    { name: "job_type",                  keyPath: "job_type",                  unique: false },
    { name: "executed_at",               keyPath: "executed_at",               unique: false },
  ],
};

// ── Record Factories ─────────────────────────────────────────────────────────

/**
 * Creates a fully validated reply record with all Phase 2 extended fields.
 * Note: Indexed boolean flags use 1/0 for standard IndexedDB keyRange compatibility.
 * @param {Object} partial
 * @returns {Object}
 */
function createReplyRecord(partial) {
  var now = new Date().toISOString();
  var rand = Math.random().toString(36).slice(2, 9);
  var base = {
    id:                           partial.id || ("rep_" + Date.now() + "_" + rand),
    source_post_id:               partial.source_post_id || "unknown",
    source_tweet_text:            partial.source_tweet_text || "",
    source_tweet_author_handle:   partial.source_tweet_author_handle || "unknown",
    reply_text:                   partial.reply_text || "",
    created_at:                   partial.created_at || now,
    last_updated_at:              partial.last_updated_at || now,
    posted_at:                    partial.posted_at || null,
    x_reply_id:                   partial.x_reply_id || null,

    // Engagement & performance metrics
    impressions:                  typeof partial.impressions === "number" ? partial.impressions : 0,
    likes:                        typeof partial.likes === "number" ? partial.likes : 0,
    replies:                      typeof partial.replies === "number" ? partial.replies : 0,
    reposts:                      typeof partial.reposts === "number" ? partial.reposts : 0,
    bookmarks:                    typeof partial.bookmarks === "number" ? partial.bookmarks : 0,
    profile_visits:               typeof partial.profile_visits === "number" ? partial.profile_visits : 0,
    author_replied:               Boolean(partial.author_replied),
    negative_feedback:            Boolean(partial.negative_feedback),
    performance_class:            partial.performance_class || null,
    performance_score:            typeof partial.performance_score === "number" ? partial.performance_score : null,

    // Content classification & vectors
    topic:                        partial.topic || null,
    intent:                       partial.intent || null,
    reply_strategy:               partial.reply_strategy || null,
    embedding:                    Array.isArray(partial.embedding) ? partial.embedding : null,
    voice_similarity_score:       typeof partial.voice_similarity_score === "number" ? partial.voice_similarity_score : null,
    semantic_similarity_score:    typeof partial.semantic_similarity_score === "number" ? partial.semantic_similarity_score : null,

    // Origin classification (indexed flags as 1/0)
    is_human_written:             partial.is_human_written ? 1 : 0,
    is_ai_generated:              partial.is_ai_generated ? 1 : 0,
    is_reused:                    Boolean(partial.is_reused),
    is_adapted:                   Boolean(partial.is_adapted),

    // Generation metadata & A/B lineage
    generation_run_id:            partial.generation_run_id || null,
    generation_model:             partial.generation_model || null,
    generation_prompt_version:    partial.generation_prompt_version || null,

    // Evaluator sub-scores
    quality_score:                typeof partial.quality_score === "number" ? partial.quality_score : null,
    accuracy_score:               typeof partial.accuracy_score === "number" ? partial.accuracy_score : null,
    specificity_score:            typeof partial.specificity_score === "number" ? partial.specificity_score : null,
    human_score:                  typeof partial.human_score === "number" ? partial.human_score : null,
    genericity_score:             typeof partial.genericity_score === "number" ? partial.genericity_score : null,

    // Data retention state (indexed flag as 1/0)
    raw_text_purged:              partial.raw_text_purged ? 1 : 0,
  };

  return base;
}

/**
 * Creates an evolvable, versioned voice style profile record.
 * @param {Object} partial
 * @returns {Object}
 */
function createVoiceProfileRecord(partial) {
  var now = new Date().toISOString();
  var version = typeof partial.version === "number" ? partial.version : 1;
  return {
    id:                    partial.id || ("vp_v" + version + "_" + Date.now()),
    version:               version,
    is_active:             partial.is_active !== undefined ? (partial.is_active ? 1 : 0) : 1,
    created_at:            partial.created_at || now,
    last_trained_at:       partial.last_trained_at || now,
    sample_size:           typeof partial.sample_size === "number" ? partial.sample_size : 0,

    // Extracted style signals
    avg_length:            typeof partial.avg_length === "number" ? partial.avg_length : 0,
    sentence_length:       typeof partial.sentence_length === "number" ? partial.sentence_length : 0,
    punctuation_patterns:  partial.punctuation_patterns && typeof partial.punctuation_patterns === "object"
                           ? partial.punctuation_patterns
                           : { exclamation: 0, question: 0, ellipsis: 0, em_dash: 0, semicolon: 0 },
    vocabulary:            partial.vocabulary && typeof partial.vocabulary === "object"
                           ? partial.vocabulary
                           : { frequent_words: [], unique_word_ratio: 0, jargon_density: 0 },
    recurring_expressions: Array.isArray(partial.recurring_expressions) ? partial.recurring_expressions : [],
    tone:                  partial.tone || "Direct",
    directness:            typeof partial.directness === "number" ? partial.directness : 0.5,
    humor_frequency:       typeof partial.humor_frequency === "number" ? partial.humor_frequency : 0,
    question_frequency:    typeof partial.question_frequency === "number" ? partial.question_frequency : 0,
    emoji_frequency:       typeof partial.emoji_frequency === "number" ? partial.emoji_frequency : 0,
    formatting_patterns:   partial.formatting_patterns && typeof partial.formatting_patterns === "object"
                           ? partial.formatting_patterns
                           : { lowercase_start: false, bullet_points_used: false, line_break_frequency: 0 },
  };
}

/**
 * Creates a reply pattern analytical record.
 * @param {Object} partial
 * @returns {Object}
 */
function createReplyPatternRecord(partial) {
  var now = new Date().toISOString();
  var rand = Math.random().toString(36).slice(2, 9);
  return {
    pattern_id:          partial.pattern_id || ("pat_" + Date.now() + "_" + rand),
    reply_id:            partial.reply_id || ("rep_ref_" + Date.now()),
    strategy:            partial.strategy || "default",
    topic:               partial.topic || "general",
    length:              typeof partial.length === "number" ? partial.length : 0,
    hook_type:           partial.hook_type || null,
    sentence_count:      typeof partial.sentence_count === "number" ? partial.sentence_count : 1,
    question_present:    partial.question_present ? 1 : 0,
    specificity:         typeof partial.specificity === "number" ? partial.specificity : 0.5,
    contrarian_level:    typeof partial.contrarian_level === "number" ? partial.contrarian_level : 0,
    humor_level:         typeof partial.humor_level === "number" ? partial.humor_level : 0,
    technical_depth:     typeof partial.technical_depth === "number" ? partial.technical_depth : 0,
    personal_experience: Boolean(partial.personal_experience),
    example_present:     Boolean(partial.example_present),
    numbers_present:     Boolean(partial.numbers_present),
    author_response:     partial.author_response ? 1 : 0,
    impressions:         typeof partial.impressions === "number" ? partial.impressions : 0,
    engagement_rate:     typeof partial.engagement_rate === "number" ? partial.engagement_rate : 0,
    profile_visit_rate:  typeof partial.profile_visit_rate === "number" ? partial.profile_visit_rate : 0,
    created_at:          partial.created_at || now,
  };
}

/**
 * Creates a generation run telemetry record for A/B testing prompt iterations.
 * @param {Object} partial
 * @returns {Object}
 */
function createGenerationRunRecord(partial) {
  var now = new Date().toISOString();
  var rand = Math.random().toString(36).slice(2, 9);
  return {
    id:                   partial.id || ("run_" + Date.now() + "_" + rand),
    timestamp:            partial.timestamp || now,
    source_post_id:       partial.source_post_id || "unknown",
    prompt_version:       partial.prompt_version || "v1.0.0",
    model:                partial.model || "gpt-4o-mini",
    temperature:          typeof partial.temperature === "number" ? partial.temperature : 1.0,
    params:               partial.params && typeof partial.params === "object"
                          ? partial.params
                          : { max_tokens: 100, length_setting: "Medium", tone_setting: "Witty" },
    retrieved_reply_ids:  Array.isArray(partial.retrieved_reply_ids) ? partial.retrieved_reply_ids : [],
    selected_strategy:    partial.selected_strategy || "default",
    output_reply:         partial.output_reply || "",
    generated_reply_id:   partial.generated_reply_id || null,

    // Evaluator sub-scores
    quality_score:        typeof partial.quality_score === "number" ? partial.quality_score : null,
    accuracy_score:       typeof partial.accuracy_score === "number" ? partial.accuracy_score : null,
    specificity_score:    typeof partial.specificity_score === "number" ? partial.specificity_score : null,
    human_score:          typeof partial.human_score === "number" ? partial.human_score : null,
    genericity_score:     typeof partial.genericity_score === "number" ? partial.genericity_score : null,
    voice_fit_score:      typeof partial.voice_fit_score === "number" ? partial.voice_fit_score : null,

    latency_ms:           typeof partial.latency_ms === "number" ? partial.latency_ms : 0,
    status:               partial.status || "success",
    error_message:        partial.error_message || null,
  };
}

// Node.js / Jest exports
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DB_NAME,
    DB_VERSION,
    STORES,
    STORE_INDEXES,
    createReplyRecord,
    createVoiceProfileRecord,
    createReplyPatternRecord,
    createGenerationRunRecord,
  };
}
