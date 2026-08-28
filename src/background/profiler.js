// src/background/profiler.js
// Phase 8 — Voice Profiler
//
// Extracts deep stylistic, structural, and behavioral signals from the user's
// historical replies and posts.
//
// Ground Rules & Fidelity:
//   1. Weight training examples by performance class:
//        OUTSTANDING: 5x, MODERATE: 2x, BASELINE: 1x
//   2. Negative signal: rejected/failed replies (Phase 6/7 taxonomy) pull the profile
//      away from those traits (e.g. suppress forced questions or generic openings).
//   3. Do NOT smooth toward grammatical correctness — preserve fragments, informal
//      punctuation (lowercase start, missing final period) if present in successful sample.
//   4. Do NOT let the model infer personality traits that are merely statistically plausible;
//      only encode traits actually observable in the sample text.
//   5. Versioned profiles (version, sample_size, last_trained_at per Phase 2 schema).

/* eslint-disable no-var */

var PROFILER_VERSION = "voice-profiler-v1.0.0";

var PERFORMANCE_WEIGHTS = {
  outstanding: 5.0,
  moderate:    2.0,
  baseline:    1.0,
  negative:    -1.5,
};

// ── Stopwords for vocabulary analysis ─────────────────────────────────────────

var STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "to", "of", "in", "for", "on",
  "with", "at", "by", "from", "as", "into", "through", "during", "i",
  "you", "he", "she", "it", "we", "they", "this", "that", "these",
  "those", "and", "or", "but", "if", "while", "because", "although",
  "about", "which", "who", "whom", "what", "where", "when", "why",
  "how", "all", "any", "both", "each", "few", "more", "most", "other",
  "some", "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "can", "just", "don't", "it's", "that's"
]);

// Technical / domain indicator keywords for jargon density
var TECH_DICTIONARY = new Set([
  "api", "sql", "db", "database", "latency", "redis", "postgres", "sqlite",
  "cache", "caching", "monolith", "microservices", "grpc", "rest", "graphql",
  "saas", "mrr", "arr", "cac", "ltv", "churn", "pricing", "conversion",
  "backend", "frontend", "docker", "k8s", "kubernetes", "infra", "deploy",
  "deployment", "ci/cd", "git", "pr", "repo", "refactor", "algorithm",
  "inference", "llm", "ai", "prompt", "embeddings", "vector", "throughput",
  "async", "concurrency", "p99", "profiling", "memory", "schema", "indexer",
  "auth", "token", "payload", "indie", "founder", "bootstrap", "mvp"
]);

// Hedging expressions that decrease directness
var HEDGING_PATTERNS = [
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  /\bsort of\b/i,
  /\bkind of\b/i,
  /\bi think\b/i,
  /\bi guess\b/i,
  /\bjust my two cents\b/i,
  /\bcould be wrong\b/i,
  /\bnot sure but\b/i,
  /\bseems like\b/i,
  /\bpossibly\b/i,
];

// Humor / wit markers
var HUMOR_PATTERNS = [
  /\b(lol|haha|lmao|rofl)\b/i,
  /😅|😂|🤣|💀|👀|🙃/,
  /\bthe irony is\b/i,
  /\bplot twist\b/i,
  /\bfamous last words\b/i,
];

// Emoji detection regex
var EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

// ── Signal Extractor for Single Text ──────────────────────────────────────────

/**
 * Extracts observable stylistic features from a single text string.
 * @param {string} text
 * @returns {Object} raw feature counts
 */
function extractTextFeatures(text) {
  if (!text || typeof text !== "string") {
    return {
      charLength: 0,
      wordCount: 0,
      sentenceCount: 0,
      exclamationCount: 0,
      questionCount: 0,
      ellipsisCount: 0,
      emDashCount: 0,
      semicolonCount: 0,
      hasTrailingPeriod: false,
      isLowercaseStart: false,
      hasBulletPoints: false,
      lineBreaks: 0,
      hasEmoji: false,
      emojiCount: 0,
      hasNumbers: false,
      hasPersonalExperience: false,
      hasExample: false,
      hasDisagreement: false,
      hasHumor: false,
      hasHedging: false,
      jargonCount: 0,
      tokens: [],
      words: [],
    };
  }

  var trimmed = text.trim();
  var charLength = trimmed.length;

  // Words & Tokens
  var rawWords = trimmed.split(/\s+/).filter(Boolean);
  var wordCount = rawWords.length;
  var cleanedTokens = rawWords.map(function (w) {
    return w.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, "");
  }).filter(Boolean);

  // Sentences & Fragments
  var sentenceSplits = trimmed.split(/[.!?\n]+/).filter(function (s) {
    return s.trim().length > 0;
  });
  var sentenceCount = Math.max(1, sentenceSplits.length);

  // Punctuation counts
  var exclamationCount = (trimmed.match(/!/g) || []).length;
  var questionCount    = (trimmed.match(/\?/g) || []).length;
  var ellipsisCount    = (trimmed.match(/\.\.\.|…/g) || []).length;
  var emDashCount      = (trimmed.match(/—|--/g) || []).length;
  var semicolonCount   = (trimmed.match(/;/g) || []).length;

  // Formatting & Case traits
  var hasTrailingPeriod = /[^.]\.$/.test(trimmed);
  var isLowercaseStart  = /^[a-z]/.test(trimmed);
  var hasBulletPoints   = /^[•\-\*]\s+/m.test(trimmed);
  var lineBreaks        = (trimmed.match(/\n/g) || []).length;

  // Emojis
  var emojiMatches = trimmed.match(new RegExp(EMOJI_REGEX.source, "gu")) || [];
  var emojiCount   = emojiMatches.length;

  // Semantic / Style traits
  var hasNumbers = /\b\d+(?:[.,]\d+)?\b/.test(trimmed);
  var hasPersonalExperience = /\b(i|my|we|our|me|us)\b/i.test(trimmed);
  var hasExample = /\b(e\.g\.|for example|such as|specifically|like when|case in point)\b/i.test(trimmed);
  var hasDisagreement = /\b(however|but|though|although|except|contrary|disagree|instead|actually)\b/i.test(trimmed);
  var hasHumor = HUMOR_PATTERNS.some(function (re) { return re.test(trimmed); });
  var hasHedging = HEDGING_PATTERNS.some(function (re) { return re.test(trimmed); });

  // Jargon count
  var jargonCount = 0;
  cleanedTokens.forEach(function (token) {
    if (TECH_DICTIONARY.has(token)) jargonCount++;
  });

  return {
    charLength:            charLength,
    wordCount:             wordCount,
    sentenceCount:         sentenceCount,
    exclamationCount:      exclamationCount,
    questionCount:         questionCount,
    ellipsisCount:         ellipsisCount,
    emDashCount:           emDashCount,
    semicolonCount:        semicolonCount,
    hasTrailingPeriod:     hasTrailingPeriod,
    isLowercaseStart:      isLowercaseStart,
    hasBulletPoints:       hasBulletPoints,
    lineBreaks:            lineBreaks,
    hasEmoji:              emojiCount > 0,
    emojiCount:            emojiCount,
    hasNumbers:            hasNumbers,
    hasPersonalExperience: hasPersonalExperience,
    hasExample:            hasExample,
    hasDisagreement:       hasDisagreement,
    hasHumor:              hasHumor,
    hasHedging:            hasHedging,
    jargonCount:           jargonCount,
    tokens:                cleanedTokens,
    words:                 rawWords,
  };
}

// ── N-Gram Extractor ──────────────────────────────────────────────────────────

/**
 * Extracts bigrams and trigrams from tokens.
 * @param {Array<string>} tokens
 * @returns {Array<string>}
 */
function extractNGrams(tokens) {
  var ngrams = [];
  if (!tokens || tokens.length < 2) return ngrams;

  // Bigrams
  for (var i = 0; i < tokens.length - 1; i++) {
    if (!STOPWORDS.has(tokens[i]) || !STOPWORDS.has(tokens[i + 1])) {
      ngrams.push(tokens[i] + " " + tokens[i + 1]);
    }
  }

  // Trigrams
  for (var j = 0; j < tokens.length - 2; j++) {
    ngrams.push(tokens[j] + " " + tokens[j + 1] + " " + tokens[j + 2]);
  }

  return ngrams;
}

// ── Main Voice Profiler Aggregator ───────────────────────────────────────────

/**
 * Builds or updates a voice style profile from historical positive and negative samples.
 *
 * @param {Array<Object>} positiveSamples - array of { text, performance_class, strategy, topic }
 * @param {Array<Object>} [negativeSamples] - array of { text, failure_tag }
 * @param {Object} [previousProfile] - existing voice profile object
 * @returns {Object} versioned voice profile object matching Phase 2 schema
 */
function trainVoiceProfile(positiveSamples, negativeSamples, previousProfile) {
  positiveSamples = Array.isArray(positiveSamples) ? positiveSamples : [];
  negativeSamples = Array.isArray(negativeSamples) ? negativeSamples : [];

  var version = previousProfile && typeof previousProfile.version === "number"
    ? previousProfile.version + 1
    : 1;

  var totalWeight = 0;
  var weightedChars = 0;
  var weightedWords = 0;
  var weightedSentences = 0;

  var weightedExclamations = 0;
  var weightedQuestions = 0;
  var weightedEllipses = 0;
  var weightedEmDashes = 0;
  var weightedSemicolons = 0;
  var weightedTrailingPeriods = 0;
  var weightedLowercaseStarts = 0;
  var weightedBulletPoints = 0;
  var weightedLineBreaks = 0;

  var weightedEmojis = 0;
  var weightedNumbers = 0;
  var weightedPersonalExp = 0;
  var weightedExamples = 0;
  var weightedDisagreements = 0;
  var weightedHumor = 0;
  var weightedHedging = 0;
  var weightedJargon = 0;

  var wordFreqMap = {};
  var ngramFreqMap = {};
  var topicFreqMap = {};
  var strategyFreqMap = {};
  var totalTokensCount = 0;

  // Process positive samples
  positiveSamples.forEach(function (sample) {
    var text = typeof sample === "string" ? sample : (sample.text || sample.reply_text || "");
    if (!text || text.trim().length === 0) return;

    var perfClass = (sample.performance_class || "baseline").toLowerCase();
    var weight = PERFORMANCE_WEIGHTS[perfClass] || PERFORMANCE_WEIGHTS.baseline;

    var feat = extractTextFeatures(text);

    totalWeight += weight;
    weightedChars += feat.charLength * weight;
    weightedWords += feat.wordCount * weight;
    weightedSentences += feat.sentenceCount * weight;

    weightedExclamations += (feat.exclamationCount > 0 ? 1 : 0) * weight;
    weightedQuestions    += (feat.questionCount > 0 ? 1 : 0) * weight;
    weightedEllipses     += (feat.ellipsisCount > 0 ? 1 : 0) * weight;
    weightedEmDashes     += (feat.emDashCount > 0 ? 1 : 0) * weight;
    weightedSemicolons   += (feat.semicolonCount > 0 ? 1 : 0) * weight;
    weightedTrailingPeriods += (feat.hasTrailingPeriod ? 1 : 0) * weight;
    weightedLowercaseStarts += (feat.isLowercaseStart ? 1 : 0) * weight;
    weightedBulletPoints    += (feat.hasBulletPoints ? 1 : 0) * weight;
    weightedLineBreaks      += feat.lineBreaks * weight;

    weightedEmojis        += (feat.hasEmoji ? 1 : 0) * weight;
    weightedNumbers       += (feat.hasNumbers ? 1 : 0) * weight;
    weightedPersonalExp   += (feat.hasPersonalExperience ? 1 : 0) * weight;
    weightedExamples      += (feat.hasExample ? 1 : 0) * weight;
    weightedDisagreements += (feat.hasDisagreement ? 1 : 0) * weight;
    weightedHumor         += (feat.hasHumor ? 1 : 0) * weight;
    weightedHedging       += (feat.hasHedging ? 1 : 0) * weight;
    weightedJargon        += feat.jargonCount * weight;

    // Word frequencies
    feat.tokens.forEach(function (token) {
      totalTokensCount += weight;
      if (!STOPWORDS.has(token) && token.length > 2) {
        wordFreqMap[token] = (wordFreqMap[token] || 0) + weight;
      }
    });

    // N-gram frequencies
    var ngrams = extractNGrams(feat.tokens);
    ngrams.forEach(function (ng) {
      ngramFreqMap[ng] = (ngramFreqMap[ng] || 0) + weight;
    });

    // Topic & Strategy tracking
    if (sample.topic) {
      topicFreqMap[sample.topic] = (topicFreqMap[sample.topic] || 0) + weight;
    }
    if (sample.reply_strategy) {
      strategyFreqMap[sample.reply_strategy] = (strategyFreqMap[sample.reply_strategy] || 0) + weight;
    }
  });

  // Process negative samples (pull away from bad traits)
  var negativePenalty = 0;
  negativeSamples.forEach(function (sample) {
    var text = typeof sample === "string" ? sample : (sample.reply_text || sample.text || "");
    if (!text) return;
    var feat = extractTextFeatures(text);

    // If negative samples exhibit excessive questions or hedging, penalize those rates
    if (feat.questionCount > 0) negativePenalty += 0.05;
    if (feat.hasHedging) negativePenalty += 0.05;
  });

  // Calculate normalized metrics
  var sampleCount = positiveSamples.length;
  var safeWeight = totalWeight > 0 ? totalWeight : 1;

  var avgLength = Math.round(weightedChars / safeWeight);
  var avgWords  = Math.round((weightedWords / safeWeight) * 10) / 10;
  var wordsPerSentence = Math.round((weightedWords / Math.max(1, weightedSentences)) * 10) / 10;

  // Directness: 1.0 - (hedging frequency), clamped [0.0, 1.0]
  var hedgingRate = weightedHedging / safeWeight;
  var directness = Math.max(0.1, Math.min(1.0, 1.0 - hedgingRate));

  var exclamationFreq = Math.round((weightedExclamations / safeWeight) * 100) / 100;
  var questionFreq    = Math.max(0, Math.round(((weightedQuestions / safeWeight) - negativePenalty) * 100) / 100);
  var ellipsisFreq    = Math.round((weightedEllipses / safeWeight) * 100) / 100;
  var emDashFreq      = Math.round((weightedEmDashes / safeWeight) * 100) / 100;
  var semicolonFreq   = Math.round((weightedSemicolons / safeWeight) * 100) / 100;

  var emojiFreq        = Math.round((weightedEmojis / safeWeight) * 100) / 100;
  var humorFreq        = Math.round((weightedHumor / safeWeight) * 100) / 100;
  var disagreementFreq = Math.round((weightedDisagreements / safeWeight) * 100) / 100;
  var numbersFreq      = Math.round((weightedNumbers / safeWeight) * 100) / 100;
  var personalExpFreq  = Math.round((weightedPersonalExp / safeWeight) * 100) / 100;
  var examplesFreq     = Math.round((weightedExamples / safeWeight) * 100) / 100;

  var isLowercaseStart = (weightedLowercaseStarts / safeWeight) > 0.35;
  var isBulletPoints   = (weightedBulletPoints / safeWeight) > 0.20;
  var lineBreakFreq    = Math.round((weightedLineBreaks / safeWeight) * 10) / 10;

  // Vocabulary & Jargon
  var frequentWords = Object.keys(wordFreqMap)
    .sort(function (a, b) { return wordFreqMap[b] - wordFreqMap[a]; })
    .slice(0, 15);

  var technicalVocab = frequentWords.filter(function (w) { return TECH_DICTIONARY.has(w); });
  var jargonDensity  = Math.round((weightedJargon / Math.max(1, weightedWords)) * 100) / 100;
  var uniqueWordRatio = Math.round((Object.keys(wordFreqMap).length / Math.max(1, totalTokensCount)) * 100) / 100;

  // Recurring expressions
  var recurringExpressions = Object.keys(ngramFreqMap)
    .filter(function (ng) { return ngramFreqMap[ng] >= 2.0; })
    .sort(function (a, b) { return ngramFreqMap[b] - ngramFreqMap[a]; })
    .slice(0, 8);

  // Preferred topics & strategies
  var preferredTopics = Object.keys(topicFreqMap)
    .sort(function (a, b) { return topicFreqMap[b] - topicFreqMap[a]; })
    .slice(0, 5);

  var preferredStrategies = Object.keys(strategyFreqMap)
    .sort(function (a, b) { return strategyFreqMap[b] - strategyFreqMap[a]; })
    .slice(0, 5);

  // Determine Tone based strictly on observable data
  var tone = "Direct";
  if (humorFreq >= 0.35) {
    tone = "Witty";
  } else if (jargonDensity >= 0.15 || numbersFreq >= 0.35) {
    tone = "Analytical";
  } else if (disagreementFreq >= 0.30) {
    tone = "Contrarian";
  } else if (personalExpFreq >= 0.40) {
    tone = "Reflective";
  } else if (directness < 0.6) {
    tone = "Casual";
  }

  var now = new Date().toISOString();

  return {
    id:                    "vp_v" + version + "_" + Date.now(),
    version:               version,
    is_active:             1,
    created_at:            previousProfile ? previousProfile.created_at : now,
    last_trained_at:       now,
    sample_size:           sampleCount,

    // Length & Structure
    avg_length:            avgLength,
    avg_words:             avgWords,
    sentence_length:       wordsPerSentence,

    // Punctuation & Formatting
    punctuation_patterns: {
      exclamation:         exclamationFreq,
      question:            questionFreq,
      ellipsis:            ellipsisFreq,
      em_dash:             emDashFreq,
      semicolon:           semicolonFreq,
      trailing_periods:    Math.round((weightedTrailingPeriods / safeWeight) * 100) / 100,
    },
    formatting_patterns: {
      lowercase_start:     isLowercaseStart,
      bullet_points_used:  isBulletPoints,
      line_break_frequency: lineBreakFreq,
    },

    // Vocabulary & Signals
    vocabulary: {
      frequent_words:      frequentWords,
      technical_vocabulary: technicalVocab,
      unique_word_ratio:   uniqueWordRatio,
      jargon_density:      jargonDensity,
    },
    recurring_expressions: recurringExpressions,

    // Behavioral & Tone Scores (0.0 - 1.0)
    tone:                  tone,
    directness:            directness,
    humor_frequency:       humorFreq,
    disagreement_frequency: disagreementFreq,
    use_of_numbers:        numbersFreq,
    use_of_personal_experience: personalExpFreq,
    use_of_examples:       examplesFreq,
    question_frequency:    questionFreq,
    emoji_frequency:       emojiFreq,

    // Preferences
    preferred_topics:      preferredTopics,
    preferred_strategies:  preferredStrategies,
    profiler_version:      PROFILER_VERSION,
  };
}

// ── Prompt Formatter for Generation Injection ─────────────────────────────────

/**
 * Formats a voice profile into a concise, high-fidelity prompt directive block.
 * Injected into LLM system prompts without hallucinated personality tropes.
 *
 * @param {Object} profile - voice profile record
 * @returns {string} formatted prompt block
 */
function formatVoiceProfileForPrompt(profile) {
  if (!profile) return "";

  var lines = [
    "== LEARNED VOICE PROFILE (v" + (profile.version || 1) + " — trained on " + (profile.sample_size || 0) + " samples) ==",
    "- Dominant Tone: " + (profile.tone || "Direct") + " (Directness: " + Math.round((profile.directness || 0.8) * 100) + "%)",
    "- Target Length: ~" + (profile.avg_words || 20) + " words per reply (~" + (profile.sentence_length || 12) + " words/sentence)",
  ];

  // Specific observable rules
  var punc = profile.punctuation_patterns || {};
  var puncRules = [];
  if (punc.question != null && punc.question < 0.20) {
    puncRules.push("Rarely ask questions (" + Math.round(punc.question * 100) + "% rate)");
  }
  if (punc.exclamation != null && punc.exclamation < 0.15) {
    puncRules.push("Avoid exclamation marks");
  }
  if (punc.em_dash != null && punc.em_dash > 0.25) {
    puncRules.push("Frequently uses em-dashes (—) to connect thoughts");
  }
  if (profile.formatting_patterns && profile.formatting_patterns.lowercase_start) {
    puncRules.push("Informal lowercase opening permitted");
  }
  if (punc.trailing_periods != null && punc.trailing_periods < 0.40) {
    puncRules.push("Often omits trailing period on punchy single-sentence thoughts");
  }
  if (puncRules.length > 0) {
    lines.push("- Punctuation Rules: " + puncRules.join("; "));
  }

  // Technical & Domain Vocabulary
  if (profile.vocabulary && profile.vocabulary.technical_vocabulary && profile.vocabulary.technical_vocabulary.length > 0) {
    lines.push("- Domain Vocabulary: " + profile.vocabulary.technical_vocabulary.slice(0, 8).join(", "));
  }

  // Recurring expressions
  if (profile.recurring_expressions && profile.recurring_expressions.length > 0) {
    lines.push("- Natural Expressions: \"" + profile.recurring_expressions.slice(0, 4).join("\", \"") + "\"");
  }

  // Behavioral traits
  if (profile.use_of_numbers > 0.3) {
    lines.push("- Empirical style: Prefers citing concrete numbers/ratios over vague qualitative claims");
  }
  if (profile.disagreement_frequency > 0.25) {
    lines.push("- Nuance style: Regularly offers polite counter-points or boundary caveats");
  }

  lines.push("Match these specific stylistic rhythms precisely. Do NOT default to generic enthusiastic AI tone.");
  return lines.join("\n");
}

// ── Database Sync / Training Trigger ──────────────────────────────────────────

/**
 * Reads all stored historical replies + manual rejections from IndexedDB,
 * computes an updated voice profile, and saves it to the database.
 *
 * @param {Object} [databaseLayer] - optional mock/injected database module
 * @returns {Promise<Object>} saved voice profile record
 */
async function syncVoiceProfileFromDatabase(databaseLayer) {
  var dbRepo = databaseLayer || (typeof voiceProfilesRepo !== "undefined" ? {
    repliesRepo: repliesRepo,
    voiceProfilesRepo: voiceProfilesRepo,
  } : null);

  if (!dbRepo || !dbRepo.repliesRepo || !dbRepo.voiceProfilesRepo) {
    return null;
  }

  try {
    var storedReplies = await dbRepo.repliesRepo.getRecentReplies(300);
    var activeProfile = await dbRepo.voiceProfilesRepo.getActiveVoiceProfile();

    // Get manual rejections from storage if available
    var negativeSamples = [];
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      var storeData = await new Promise(function (resolve) {
        chrome.storage.local.get({ manualRejections: [] }, resolve);
      });
      negativeSamples = storeData.manualRejections || [];
    }

    if (storedReplies.length === 0) {
      return activeProfile;
    }

    var newProfile = trainVoiceProfile(storedReplies, negativeSamples, activeProfile);
    var savedRecord = await dbRepo.voiceProfilesRepo.saveVoiceProfile(newProfile);
    return savedRecord;
  } catch (err) {
    console.warn("[ReplyGenie] syncVoiceProfileFromDatabase error:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PROFILER_VERSION,
    PERFORMANCE_WEIGHTS,
    STOPWORDS,
    TECH_DICTIONARY,
    extractTextFeatures,
    extractNGrams,
    trainVoiceProfile,
    formatVoiceProfileForPrompt,
    syncVoiceProfileFromDatabase,
  };
}
