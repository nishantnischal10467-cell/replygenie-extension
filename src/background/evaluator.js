// src/background/evaluator.js
// Phase 6 — Quality / Accuracy / Genericity Gate
//
// Components:
//   1. FAILURE_TAGS       — canonical taxonomy for rejected candidates
//   2. detectForcedQuestion()   — engagement-bait question detector
//   3. computeGenericityScore() — heuristic: "could this be posted under 20 unrelated tweets?"
//   4. extractClaims()          — pull factual assertions from text (regex)
//   5. checkClaimSupport()      — verify claim against source + context
//   6. detectDuplicate()        — cosine + n-gram similarity guard
//   7. detectRepeatedStructure()— opener-construction repetition guard
//   8. evaluateCandidate()      — single-candidate LLM scorer (0-10 per dimension)
//   9. evaluateCandidates()     — gate all 3 candidates, regeneration loop, human-review queue
//
// Design:
//   - All thresholds are config objects, never inline literals.
//   - The pure heuristic functions (1-7) have NO API calls — fully testable.
//   - evaluateCandidate() calls OpenAI once per candidate (reuses apiConfig).
//   - evaluateCandidates() orchestrates: evaluate → reject loop → regenerate once → queue.

/* eslint-disable no-var */

var EVALUATOR_PROMPT_VERSION = "evaluator-v1.0.0";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Failure Taxonomy
// ─────────────────────────────────────────────────────────────────────────────

var FAILURE_TAGS = {
  GENERIC:                 "GENERIC",
  TOO_LONG:                "TOO_LONG",
  TOO_SHORT:               "TOO_SHORT",
  REPETITIVE:              "REPETITIVE",
  OBVIOUS_AI:              "OBVIOUS_AI",
  LOW_RELEVANCE:           "LOW_RELEVANCE",
  NO_NEW_VALUE:            "NO_NEW_VALUE",
  UNSUPPORTED_CLAIM:       "UNSUPPORTED_CLAIM",
  FORCED_QUESTION:         "FORCED_QUESTION",
  TOO_PROMOTIONAL:         "TOO_PROMOTIONAL",
  TOO_AGREEABLE:           "TOO_AGREEABLE",
  OVERLY_FORMAL:           "OVERLY_FORMAL",
  OFF_TOPIC:               "OFF_TOPIC",
  WEAK_HOOK:               "WEAK_HOOK",
  COPIED_STRUCTURE:        "COPIED_STRUCTURE",
  LOW_CONVERSATIONAL_VALUE:"LOW_CONVERSATIONAL_VALUE",
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Default Evaluation Thresholds (config-overridable)
// ─────────────────────────────────────────────────────────────────────────────
//
// TUNING NOTE: These defaults are conservative starting values.
// Re-tune after ≥200 evaluated replies using the failure-tag distribution.
//
// Composite score formula (all weights sum to 1.0):
//   composite = relevance*0.20 + specificity*0.15 + originality*0.15
//             + human_likeness*0.15 + accuracy*0.15 + voice_match*0.10
//             + conversation_value*0.10
//             - (genericity * genericity_penalty_weight)

var DEFAULT_EVAL_WEIGHTS = {
  relevance:          0.20,
  specificity:        0.15,
  originality:        0.15,
  human_likeness:     0.15,
  accuracy:           0.15,
  voice_match:        0.10,
  conversation_value: 0.10,
  genericity_penalty_weight: 0.10, // Genericity score (0-10) × this = deducted from composite
};

var DEFAULT_REJECTION_THRESHOLDS = {
  min_accuracy:          8,   // Hard gate — hallucination risk
  min_relevance:         8,   // Hard gate — must address the post
  max_genericity:        4,   // Hard gate — must be specific to this post
  min_composite_score:   5.0, // Soft gate — overall quality floor (0-10 scale)
  duplicate_cosine:      0.85, // Cosine similarity above this → REPETITIVE
  duplicate_ngram:       0.70, // N-gram Jaccard above this → REPETITIVE
  min_word_count:        3,   // Below this → TOO_SHORT
  max_word_count:        120, // Above this → TOO_LONG
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Forced-Question Detection
// ─────────────────────────────────────────────────────────────────────────────

// Literal banned engagement-bait endings from the spec.
// These are rejected UNLESS the question meets genuine-utility criteria (see below).
var FORCED_QUESTION_ENDINGS = [
  /\bthoughts[!?.]*\s*$/i,
  /\bwhat\s+do\s+you\s+think[!?.]*\s*$/i,
  /\bagree[!?.]*\s*$/i,
  /\bright[!?.]*\s*$/i,
  /\bdoes\s+this\s+resonate[!?.]*\s*$/i,
  /\bwould\s+you\s+agree[!?.]*\s*$/i,
  /\bam\s+i\s+wrong[!?.]*\s*$/i,
  /\bwho\s+else[!?.]*\s*$/i,
  /\bany\s+thoughts[!?.]*\s*$/i,
  /\bwhat\s+are\s+your\s+thoughts[!?.]*\s*$/i,
  /\blet\s+me\s+know\s+(what\s+you\s+think|in\s+the\s+comments?)[!?.]*\s*$/i,
  /\bdo\s+you\s+agree[!?.]*\s*$/i,
  /\bdo\s+you\s+think\s+so[!?.]*\s*$/i,
  /\bwhat\s+do\s+you\s+think\s+about\s+this[!?.]*\s*$/i,
  /\bcan\s+you\s+relate[!?.]*\s*$/i,
  /\bhave\s+you\s+experienced\s+this[!?.]*\s*$/i,
  /\bfound\s+this\s+(helpful|useful|valuable)[!?.]*\s*$/i,
];

// Genuine-utility question pattern: must contain a specific noun/verb reference
// that proves it is directed at THIS post, not generic.
var GENERIC_QUESTION_SIGNAL = [
  /^(what|how|why|when|where|who)\s+(do|did|does|is|are|was|were|should|would|could|can)\s+you/i,
  /\byour\s+thoughts\b/i,
  /\bthink about\s+(this|that|it)\b/i,
];

/**
 * Returns true if the text ends with a forced/engagement-bait question.
 * A question is NOT forced if:
 *   - It references ≥3 content words from the source post text (specificity signal)
 *
 * @param {string} text       — candidate reply text
 * @param {string} [sourceText] — source post text (used for genuine-question check)
 * @returns {{ forced: boolean, matchedPattern: string|null }}
 */
function detectForcedQuestion(text, sourceText) {
  if (!text) return { forced: false, matchedPattern: null };

  var trimmed = text.trim();
  var matchedPattern = null;

  for (var i = 0; i < FORCED_QUESTION_ENDINGS.length; i++) {
    if (FORCED_QUESTION_ENDINGS[i].test(trimmed)) {
      matchedPattern = FORCED_QUESTION_ENDINGS[i].toString();
      break;
    }
  }

  if (!matchedPattern) return { forced: false, matchedPattern: null };

  // Genuine-utility exemption: if question references specific content from source post
  if (sourceText && sourceText.length > 10) {
    var stopwords = new Set(["the","a","an","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","shall","to","of","in","for","on","with","at","by","from","as","into","through","during","i","you","he","she","it","we","they","this","that","these","those","and","or","but","if","while","because","although","about","which","who","whom"]);
    var sourceWords = sourceText.toLowerCase().split(/\W+/).filter(function(w) {
      return w.length > 3 && !stopwords.has(w);
    });

    var questionPart = trimmed.split(/[.!]\s+/).pop();
    var matchCount = 0;
    sourceWords.forEach(function(w) {
      if (questionPart.toLowerCase().includes(w)) matchCount++;
    });

    // If ≥3 source content words are in the question, it's genuine
    if (matchCount >= 3) return { forced: false, matchedPattern: null };
  }

  return { forced: true, matchedPattern: matchedPattern };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Genericity Score (heuristic)
// ─────────────────────────────────────────────────────────────────────────────

// Phrases that make a reply generic — could be posted under any tweet.
// From the spec (Section 35) + extended list from common failure patterns.
var GENERIC_PHRASES = [
  // Spec literal examples
  "great insights",
  "great insight",
  "couldn't agree more",
  "couldn't agree more",
  "so true",
  "well said",
  "love this",
  "this is so true",
  "exactly right",
  "100%",
  "totally agree",
  "such a great point",
  "this is gold",
  "absolute gold",
  "so important",
  "dropping gems",

  // Common AI-generated generic phrases
  "couldn't have said it better",
  "this resonates",
  "i can relate",
  "so much value here",
  "value bomb",
  "so many people need to hear this",
  "everyone should read this",
  "this is why i follow you",
  "always learning from you",
  "thanks for sharing",
  "great post",
  "amazing post",
  "incredible post",
  "powerful post",
  "brilliant post",
  "love your content",
  "this is inspiring",
  "so inspiring",
  "very inspiring",
  "keep it up",
  "keep going",
  "you're doing great",
  "this is the way",
  "needed to hear this today",
  "this hit different",
  "hits different",
  "preach",
  "facts 🙌",
  "🙌🙌",
  "fire 🔥",
  "💯",
];

// Structure-level genericity signals (regex)
var GENERIC_STRUCTURE_PATTERNS = [
  /^(great|amazing|incredible|brilliant|love|wow|beautiful)\s+(post|insight|content|point|work|perspective)/i,
  /^couldn'?t\s+(agree|have\s+said|have\s+put\s+it)\s+(more|better)/i,
  /^(so|very|extremely)\s+true/i,
  /^this\s+(is|was|has\s+been)\s+(so\s+)?(true|important|valuable|helpful|needed|real)/i,
  /^(well|beautifully|perfectly)\s+said/i,
  /^(totally|completely|absolutely)\s+(agree|on\s+board)/i,
  /^needed\s+to\s+hear\s+this/i,
  /^(so\s+many\s+people|everyone)\s+(need|needs|should|must)/i,
  /^(thank(s|\s+you)\s+for\s+sharing)/i,
  /^this\s+is\s+why\s+i\s+follow/i,
];

/**
 * Computes a genericity score from 0 (very specific) to 10 (completely generic).
 * A score > 4 (DEFAULT_REJECTION_THRESHOLDS.max_genericity) triggers rejection.
 *
 * Heuristic:
 *   - Start at 0
 *   - +3 for each matched generic phrase (capped at 9)
 *   - +4 for structure-level generic pattern match
 *   - -1 for each specific signal: number/stat, proper noun, "but" (contrastive), "if" (conditional)
 *   - Result clamped to [0, 10]
 *
 * @param {string} text
 * @returns {{ score: number, signals: string[] }}
 */
function computeGenericityScore(text) {
  if (!text) return { score: 0, signals: [] };

  var lower = text.toLowerCase().trim();
  var score  = 0;
  var signals = [];

  // Phrase matches
  GENERIC_PHRASES.forEach(function(phrase) {
    if (lower.includes(phrase.toLowerCase())) {
      score += 3;
      signals.push("generic_phrase:" + phrase);
    }
  });

  // Structure matches
  GENERIC_STRUCTURE_PATTERNS.forEach(function(re) {
    if (re.test(lower)) {
      score += 4;
      signals.push("generic_structure:" + re.toString().slice(0, 40));
    }
  });

  // Specificity reducers
  if (/\b\d+(\.\d+)?(%|x\b|\s*times|\s*million|\s*billion|\s*k\b)/i.test(text)) {
    score -= 1;
    signals.push("specificity:number_with_unit");
  }
  if (/\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}/.test(text)) {
    score -= 1;  // Proper noun (two capitalised words)
    signals.push("specificity:proper_noun");
  }
  if (/\b(but|however|though|although|except|unless|yet)\b/i.test(text)) {
    score -= 1;  // Contrastive — not pure agreement
    signals.push("specificity:contrast_word");
  }
  if (/\b(if|when|only\s+if|except\s+when)\b/i.test(text)) {
    score -= 1;  // Conditional — adds nuance
    signals.push("specificity:conditional");
  }

  return { score: Math.max(0, Math.min(10, score)), signals: signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Claim Extraction + Verification (AccuracyChecker)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts factual assertions from a text (heuristic regex approach).
 * Captures: numbers/stats, named entities, "X does Y" claims, comparative claims.
 *
 * @param {string} text
 * @returns {Array<string>} extracted claim strings
 */
function extractClaims(text) {
  if (!text) return [];
  var claims = [];

  // Explicit number + stat claims (e.g., "40% improvement", "3x faster", "$50k MRR", "50,000 requests")
  var numberClaimRe = /(?:\$?\b\d+(?:[.,]\d+)?\s*(?:%|x\b|\s*times|\s*k\b|\s*m\b|\s*billion|\s*million|\s*hours?|\s*days?|\s*months?|\s*years?|\s*users?|\s*customers?|\s*requests?|\s*ms\b|\s*seconds?)[^.!?]*)/gi;
  var m;
  while ((m = numberClaimRe.exec(text)) !== null) {
    var claim = m[0].trim();
    if (claim.length > 5 && claim.length < 200) claims.push(claim);
  }

  // "I [verb]..." personal experience claims
  var personalRe = /\b(I\s+(?:did|built|shipped|launched|tried|found|learned|used|worked|created|ran|tested|made|saw|experienced|noticed|discovered)[^.!?]*)/gi;
  while ((m = personalRe.exec(text)) !== null) {
    claims.push(m[0].trim());
  }

  // "[Named thing] does/is/has [property]" product/entity claims
  var entityClaimRe = /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)?)\s+(does|is|has|can|will|was|allows?|provides?|offers?|supports?|requires?)[^.!?]*/g;
  while ((m = entityClaimRe.exec(text)) !== null) {
    if (m[0].length > 10) claims.push(m[0].trim());
  }

  // Deduplicate
  return claims.filter(function(c, i, a) { return a.indexOf(c) === i; }).slice(0, 10);
}

/**
 * Checks whether a claim is supported by the available context.
 * Returns { supported: boolean, reason: string }
 *
 * Verified context sources (in priority order):
 *   1. Source post text — claim re-uses something stated in the post
 *   2. Retrieved candidate texts — claim matches established stored reply
 *   3. User profile / voice samples — personal experience claim matches known user data
 *
 * @param {string} claim
 * @param {Object} verifiedContext — { sourceText, candidateTexts, voiceSamples }
 * @returns {{ supported: boolean, reason: string }}
 */
function checkClaimSupport(claim, verifiedContext) {
  if (!claim || claim.length < 5) return { supported: true, reason: "trivial_claim" };

  verifiedContext = verifiedContext || {};
  var sourceText      = (verifiedContext.sourceText      || "").toLowerCase();
  var candidateTexts  = (verifiedContext.candidateTexts  || []).map(function(t) { return t.toLowerCase(); });
  var voiceSamples    = (verifiedContext.voiceSamples    || []).map(function(t) { return t.toLowerCase(); });

  var claimLower = claim.toLowerCase();

  // Check 1: Personal experience "I did X" — must be in voice samples
  if (/^\s*i\s+(did|built|shipped|launched|tried|found|learned|used|worked|created|ran|tested|made|saw|experienced|noticed|discovered)/i.test(claim)) {
    var inSamples = voiceSamples.some(function(s) {
      var verbs = claimLower.match(/\b(built|shipped|launched|tried|found|learned|used|worked|created|ran|tested|made|saw|experienced|noticed|discovered)\b/g) || [];
      return verbs.some(function(v) { return s.includes(v); });
    });
    if (!inSamples) {
      return { supported: false, reason: "personal_claim_not_in_voice_samples" };
    }
  }

  // Check 2: Numbers in the claim also appear in source text / verified context
  var rawNumbers = claim.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
  var numbers = rawNumbers.filter(function(n) { return !isNaN(parseFloat(n.replace(/,/g, ""))); });

  if (numbers.length > 0) {
    var allSupported = numbers.every(function(n) {
      return sourceText.includes(n) ||
             candidateTexts.some(function(t) { return t.includes(n); }) ||
             voiceSamples.some(function(t) { return t.includes(n); });
    });
    if (!allSupported) {
      return { supported: false, reason: "number_not_in_verified_context:" + numbers.join(",") };
    }
  }

  // Check 3: Named entity claims — named thing must appear in source or stored context
  var entityMatch = claim.match(/^([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)?)\s+(does|is|has|can|will|was)/);
  if (entityMatch) {
    var entity = entityMatch[1].toLowerCase();
    var inSource = sourceText.includes(entity);
    var inCandidates = candidateTexts.some(function(t) { return t.includes(entity); });
    if (!inSource && !inCandidates) {
      return { supported: false, reason: "entity_not_in_verified_context:" + entityMatch[1] };
    }
  }

  return { supported: true, reason: "claim_verified" };
}

/**
 * Checks all extracted claims in a reply against verified context.
 * Returns the first unsupported claim found, or null if all pass.
 *
 * @param {string} replyText
 * @param {Object} verifiedContext
 * @returns {{ unsupportedClaim: string|null, reason: string|null }}
 */
function checkAccuracy(replyText, verifiedContext) {
  var claims = extractClaims(replyText);
  for (var i = 0; i < claims.length; i++) {
    var result = checkClaimSupport(claims[i], verifiedContext);
    if (!result.supported) {
      return { unsupportedClaim: claims[i], reason: result.reason };
    }
  }
  return { unsupportedClaim: null, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Duplicate Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes n-gram Jaccard similarity between two texts.
 * @param {string} a
 * @param {string} b
 * @param {number} n  — n-gram size (default 2 = bigrams)
 * @returns {number} [0.0, 1.0]
 */
function ngramJaccard(a, b, n) {
  n = n || 2;
  if (!a || !b) return 0;

  function ngrams(text) {
    var tokens = text.toLowerCase().split(/\s+/);
    var result = new Set();
    for (var i = 0; i <= tokens.length - n; i++) {
      result.add(tokens.slice(i, i + n).join(" "));
    }
    return result;
  }

  var setA = ngrams(a);
  var setB = ngrams(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  var intersection = 0;
  setA.forEach(function(g) { if (setB.has(g)) intersection++; });
  var union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Word-overlap cosine similarity (bag-of-words, no vectors required).
 * Sufficient for duplicate detection without needing embedding calls.
 * @param {string} a
 * @param {string} b
 * @returns {number} [0.0, 1.0]
 */
function bowCosine(a, b) {
  if (!a || !b) return 0;
  var tokA = a.toLowerCase().split(/\s+/);
  var tokB = b.toLowerCase().split(/\s+/);
  var freqA = {};
  var freqB = {};
  tokA.forEach(function(w) { freqA[w] = (freqA[w] || 0) + 1; });
  tokB.forEach(function(w) { freqB[w] = (freqB[w] || 0) + 1; });

  var dot = 0;
  var magA = 0;
  var magB = 0;
  Object.keys(freqA).forEach(function(w) {
    dot  += freqA[w] * (freqB[w] || 0);
    magA += freqA[w] * freqA[w];
  });
  Object.keys(freqB).forEach(function(w) {
    magB += freqB[w] * freqB[w];
  });

  return (magA > 0 && magB > 0) ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

/**
 * Checks if a candidate reply is too similar to any recent or stored reply.
 * Uses both cosine (BoW) and bigram Jaccard — BOTH must exceed their threshold.
 *
 * @param {string} candidateText
 * @param {Array<string>} comparisonTexts  — recent / stored reply texts
 * @param {Object} [thresholds]            — override DEFAULT_REJECTION_THRESHOLDS
 * @returns {{ duplicate: boolean, cosine: number, ngram: number, matchedText: string|null }}
 */
function detectDuplicate(candidateText, comparisonTexts, thresholds) {
  thresholds = Object.assign({}, DEFAULT_REJECTION_THRESHOLDS, thresholds || {});
  if (!comparisonTexts || comparisonTexts.length === 0) {
    return { duplicate: false, cosine: 0, ngram: 0, matchedText: null };
  }

  var maxCosine = 0;
  var maxNgram  = 0;
  var matchedText = null;

  comparisonTexts.forEach(function(other) {
    if (!other) return;
    var cos   = bowCosine(candidateText, other);
    var ngram = ngramJaccard(candidateText, other, 2);
    if (cos > maxCosine) { maxCosine = cos; }
    if (ngram > maxNgram) { maxNgram = ngram; matchedText = other; }
  });

  var isDuplicate = maxCosine >= thresholds.duplicate_cosine &&
                    maxNgram  >= thresholds.duplicate_ngram;

  return {
    duplicate:   isDuplicate,
    cosine:      Number(maxCosine.toFixed(4)),
    ngram:       Number(maxNgram.toFixed(4)),
    matchedText: isDuplicate ? matchedText : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Repeated Structure Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the "structural opener" of a reply:
 * the first 4 content tokens, normalised for comparison.
 * @param {string} text
 * @returns {string}
 */
function extractOpenerConstruct(text) {
  if (!text) return "";
  var tokens = text.trim().toLowerCase().split(/\s+/).slice(0, 4);
  return tokens.join(" ");
}

/**
 * Returns true if the candidate's structural opener matches too many
 * of the last N recent replies (indicating COPIED_STRUCTURE failure).
 *
 * @param {string} candidateText
 * @param {Array<string>} recentTexts — last N reply texts
 * @param {number} [windowSize=5]     — how many recent replies to check
 * @param {number} [maxAllowed=2]     — how many matches trigger rejection
 * @returns {{ repeated: boolean, matchCount: number, opener: string }}
 */
function detectRepeatedStructure(candidateText, recentTexts, windowSize, maxAllowed) {
  windowSize = windowSize || 5;
  maxAllowed = maxAllowed || 2;
  if (!recentTexts || recentTexts.length === 0) return { repeated: false, matchCount: 0, opener: "" };

  var candidateOpener = extractOpenerConstruct(candidateText);
  if (!candidateOpener) return { repeated: false, matchCount: 0, opener: "" };

  var window = recentTexts.slice(-windowSize);
  var matchCount = 0;
  window.forEach(function(r) {
    var opener = extractOpenerConstruct(r);
    // Match if first 2 tokens are identical (same structural start)
    var cHead = candidateOpener.split(" ").slice(0, 2).join(" ");
    var rHead = opener.split(" ").slice(0, 2).join(" ");
    if (cHead && rHead && cHead === rHead) matchCount++;
  });

  return {
    repeated:   matchCount >= maxAllowed,
    matchCount: matchCount,
    opener:     candidateOpener,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Heuristic pre-screening (fast, no API call)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs all heuristic checks on a single candidate reply.
 * Returns a list of failure tags (empty = pass).
 *
 * @param {string} replyText
 * @param {string} sourceText
 * @param {Array<string>} recentTexts
 * @param {Object} verifiedContext
 * @param {Object} [thresholds]
 * @returns {{ failureTags: string[], details: Object }}
 */
function heuristicScreen(replyText, sourceText, recentTexts, verifiedContext, thresholds) {
  thresholds = Object.assign({}, DEFAULT_REJECTION_THRESHOLDS, thresholds || {});
  var failureTags = [];
  var details = {};

  if (!replyText) {
    return { failureTags: [FAILURE_TAGS.TOO_SHORT], details: { reason: "empty_text" } };
  }

  // Word count
  var wordCount = replyText.trim().split(/\s+/).length;
  if (wordCount < thresholds.min_word_count) {
    failureTags.push(FAILURE_TAGS.TOO_SHORT);
    details.wordCount = wordCount;
  }
  if (wordCount > thresholds.max_word_count) {
    failureTags.push(FAILURE_TAGS.TOO_LONG);
    details.wordCount = wordCount;
  }

  // Genericity
  var genResult = computeGenericityScore(replyText);
  details.genericityScore  = genResult.score;
  details.genericitySignals = genResult.signals;
  if (genResult.score > thresholds.max_genericity) {
    failureTags.push(FAILURE_TAGS.GENERIC);
  }

  // Forced question
  var fqResult = detectForcedQuestion(replyText, sourceText);
  details.forcedQuestion = fqResult;
  if (fqResult.forced) {
    failureTags.push(FAILURE_TAGS.FORCED_QUESTION);
  }

  // Duplicate detection
  var dupResult = detectDuplicate(replyText, recentTexts, thresholds);
  details.duplicate = dupResult;
  if (dupResult.duplicate) {
    failureTags.push(FAILURE_TAGS.REPETITIVE);
  }

  // Repeated structure
  var structResult = detectRepeatedStructure(replyText, recentTexts);
  details.repeatedStructure = structResult;
  if (structResult.repeated) {
    failureTags.push(FAILURE_TAGS.COPIED_STRUCTURE);
  }

  // Accuracy (claim verification)
  var accuracyResult = checkAccuracy(replyText, verifiedContext);
  details.accuracy = accuracyResult;
  if (accuracyResult.unsupportedClaim) {
    failureTags.push(FAILURE_TAGS.UNSUPPORTED_CLAIM);
  }

  return { failureTags: failureTags, details: details };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Composite score from LLM evaluation output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the composite score from raw LLM dimension scores.
 * Formula (weights sum to 1.0):
 *   composite = relevance*0.20 + specificity*0.15 + originality*0.15
 *             + human_likeness*0.15 + accuracy*0.15 + voice_match*0.10
 *             + conversation_value*0.10
 *             - (genericity * genericity_penalty_weight)
 *
 * @param {Object} scores — { relevance, specificity, originality, human_likeness, accuracy, voice_match, conversation_value, genericity }
 * @param {Object} [weights] — override DEFAULT_EVAL_WEIGHTS
 * @returns {{ composite: number, hardRejectReason: string|null }}
 */
function computeCompositeScore(scores, weights) {
  weights = Object.assign({}, DEFAULT_EVAL_WEIGHTS, weights || {});
  scores  = scores || {};

  var relevance         = typeof scores.relevance         === "number" ? scores.relevance         : 0;
  var specificity       = typeof scores.specificity       === "number" ? scores.specificity       : 0;
  var originality       = typeof scores.originality       === "number" ? scores.originality       : 0;
  var human_likeness    = typeof scores.human_likeness    === "number" ? scores.human_likeness    : 0;
  var accuracy          = typeof scores.accuracy          === "number" ? scores.accuracy          : 0;
  var voice_match       = typeof scores.voice_match       === "number" ? scores.voice_match       : 0;
  var conversation_value= typeof scores.conversation_value=== "number" ? scores.conversation_value: 0;
  var genericity        = typeof scores.genericity        === "number" ? scores.genericity        : 0;

  var composite =
    (relevance          * weights.relevance)          +
    (specificity        * weights.specificity)        +
    (originality        * weights.originality)        +
    (human_likeness     * weights.human_likeness)     +
    (accuracy           * weights.accuracy)           +
    (voice_match        * weights.voice_match)        +
    (conversation_value * weights.conversation_value) -
    (genericity         * weights.genericity_penalty_weight);

  composite = Math.max(0, Math.min(10, composite));

  // Hard rejection gates (config-overridable via thresholds param to caller)
  var hardRejectReason = null;
  if (accuracy  < DEFAULT_REJECTION_THRESHOLDS.min_accuracy)  hardRejectReason = "accuracy_below_minimum:" + accuracy;
  if (relevance < DEFAULT_REJECTION_THRESHOLDS.min_relevance) hardRejectReason = "relevance_below_minimum:" + relevance;
  if (genericity > DEFAULT_REJECTION_THRESHOLDS.max_genericity) hardRejectReason = "genericity_above_maximum:" + genericity;

  return {
    composite:        Number(composite.toFixed(3)),
    hardRejectReason: hardRejectReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. LLM Evaluator prompt + call
// ─────────────────────────────────────────────────────────────────────────────

var EVALUATOR_SYSTEM_PROMPT = [
  "You are evaluating the quality of a candidate reply to an X (Twitter) post.",
  "Score each dimension 0-10 (10 = perfect). Return ONLY valid JSON — no markdown, no explanation.",
  "",
  "Dimension definitions:",
  "  relevance:          Does the reply directly address the specific post? (Not a generic comment)",
  "  specificity:        Does it reference specific details, numbers, or claims from the post?",
  "  originality:        Does it add something new that was not already said in the post?",
  "  human_likeness:     Does it sound like a real person, not an AI assistant?",
  "  accuracy:           Are all claims in the reply supported by the post text or provided context?",
  "  voice_match:        Does it match the provided voice profile?",
  "  conversation_value: Would this reply add value to the conversation for other readers?",
  "  genericity:         How generic is it? (0=very specific to this post, 10=could be posted under any tweet)",
  "  question_necessity: If the reply ends with a question: was the question necessary? (0=unnecessary/bait, 10=essential) — 5 if no question.",
  "",
  "Hard rejection signals (note in rejection_reasons if triggered):",
  "  - Reply restates the post without adding anything",
  "  - Reply praises the author (Great post!, Well said!, etc.)",
  "  - Reply invents facts not in the post",
  "  - Reply ends with engagement bait (Thoughts? Agree? Right? Does this resonate?)",
  "  - Reply is so generic it could apply to any tweet",
  "",
  "Return JSON exactly:",
  "{",
  "  \"relevance\": 0-10,",
  "  \"specificity\": 0-10,",
  "  \"originality\": 0-10,",
  "  \"human_likeness\": 0-10,",
  "  \"accuracy\": 0-10,",
  "  \"voice_match\": 0-10,",
  "  \"conversation_value\": 0-10,",
  "  \"genericity\": 0-10,",
  "  \"question_necessity\": 0-10,",
  "  \"rejection_reasons\": [\"reason1\", \"reason2\"]",
  "}",
].join("\n");

/**
 * Calls OpenAI to evaluate a single candidate reply.
 *
 * @param {string} candidateText       — the reply to evaluate
 * @param {string} sourcePostText      — the original post
 * @param {Object} profile             — user profile (voiceSamples, tone)
 * @param {Object} apiConfig           — { apiKey, model, apiUrl }
 * @param {Function} buildPromptContextFn
 * @returns {Promise<{ scores, composite, hardRejectReason, llmRejectionReasons, failureTags }>}
 */
async function evaluateCandidate(candidateText, sourcePostText, profile, apiConfig, buildPromptContextFn) {
  var pCtx = buildPromptContextFn({ text: sourcePostText || "", handle: "" });

  var voiceInfo = "";
  if (profile && profile.voiceSamples && profile.voiceSamples.length > 0) {
    voiceInfo = "\n\nVoice profile samples:\n" +
      profile.voiceSamples.slice(-4).map(function(s, i) { return (i + 1) + ". " + s; }).join("\n");
  }

  var userMessage =
    pCtx.userBlock +
    "\n\n[CANDIDATE_REPLY]\n" + candidateText.slice(0, 600) + "\n[/CANDIDATE_REPLY]" +
    voiceInfo +
    "\n\nEvaluate the candidate reply. Return only valid JSON.";

  var body = {
    model:      apiConfig.model || "gpt-4o-mini",
    max_tokens: 400,
    messages: [
      { role: "system", content: pCtx.systemPreamble + "\n\n" + EVALUATOR_SYSTEM_PROMPT },
      { role: "user",   content: userMessage },
    ],
  };

  var res = await fetch(apiConfig.apiUrl || "https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiConfig.apiKey },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error("Evaluator API error (" + res.status + "): " + errText.slice(0, 200));
  }

  var data   = await res.json();
  var choice = data.choices && data.choices[0];
  if (!choice || !choice.message || !choice.message.content) {
    throw new Error("Evaluator: no content returned.");
  }

  var raw = choice.message.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    // Graceful fallback: neutral scores so we don't false-reject on evaluator failure
    parsed = {
      relevance: 7, specificity: 7, originality: 7, human_likeness: 7,
      accuracy: 8, voice_match: 7, conversation_value: 7, genericity: 3,
      question_necessity: 5, rejection_reasons: ["json_parse_failed"],
    };
  }

  // Clamp all scores to [0, 10]
  var DIM_KEYS = ["relevance","specificity","originality","human_likeness","accuracy","voice_match","conversation_value","genericity","question_necessity"];
  DIM_KEYS.forEach(function(k) {
    parsed[k] = Math.max(0, Math.min(10, typeof parsed[k] === "number" ? parsed[k] : 5));
  });

  var scoreResult = computeCompositeScore(parsed);

  // Map LLM rejection reasons to failure tags
  var failureTags = [];
  var reasons = Array.isArray(parsed.rejection_reasons) ? parsed.rejection_reasons : [];
  if (parsed.genericity > DEFAULT_REJECTION_THRESHOLDS.max_genericity)   failureTags.push(FAILURE_TAGS.GENERIC);
  if (parsed.accuracy   < DEFAULT_REJECTION_THRESHOLDS.min_accuracy)     failureTags.push(FAILURE_TAGS.UNSUPPORTED_CLAIM);
  if (parsed.relevance  < DEFAULT_REJECTION_THRESHOLDS.min_relevance)    failureTags.push(FAILURE_TAGS.LOW_RELEVANCE);
  if (parsed.originality < 5)       failureTags.push(FAILURE_TAGS.NO_NEW_VALUE);
  if (parsed.human_likeness < 5)    failureTags.push(FAILURE_TAGS.OBVIOUS_AI);
  if (parsed.question_necessity < 4) failureTags.push(FAILURE_TAGS.FORCED_QUESTION);
  if (parsed.conversation_value < 4) failureTags.push(FAILURE_TAGS.LOW_CONVERSATIONAL_VALUE);
  reasons.forEach(function(r) {
    if (/generic/i.test(r))      failureTags.push(FAILURE_TAGS.GENERIC);
    if (/praise/i.test(r))       failureTags.push(FAILURE_TAGS.TOO_AGREEABLE);
    if (/formal/i.test(r))       failureTags.push(FAILURE_TAGS.OVERLY_FORMAL);
    if (/promot/i.test(r))       failureTags.push(FAILURE_TAGS.TOO_PROMOTIONAL);
    if (/off.?topic/i.test(r))   failureTags.push(FAILURE_TAGS.OFF_TOPIC);
    if (/hook/i.test(r))         failureTags.push(FAILURE_TAGS.WEAK_HOOK);
  });
  // Deduplicate
  failureTags = failureTags.filter(function(t, i, a) { return a.indexOf(t) === i; });

  return {
    scores:              parsed,
    composite:           scoreResult.composite,
    hardRejectReason:    scoreResult.hardRejectReason,
    llmRejectionReasons: reasons,
    failureTags:         failureTags,
    promptVersion:       EVALUATOR_PROMPT_VERSION,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Gate: evaluate all candidates, regenerate if all fail
// ─────────────────────────────────────────────────────────────────────────────

var HUMAN_REVIEW_QUEUE_KEY = "humanReviewQueue";

/**
 * Main quality gate. Evaluates all candidate replies, selects the best passing one,
 * or regenerates once with failure feedback if all fail.
 *
 * @param {Array<{text}>}  candidates        — from generateCandidates()
 * @param {Object}         context           — source post context
 * @param {Object}         profile           — user profile
 * @param {Array<string>}  recentTexts       — recent reply texts
 * @param {Object}         verifiedContext   — { sourceText, candidateTexts, voiceSamples }
 * @param {Object}         apiConfig         — { apiKey, model, apiUrl }
 * @param {Function}       buildPromptContextFn
 * @param {Function}       regenerateFn      — async (failureReasons) => { candidates }
 * @param {Object}         [thresholds]      — override DEFAULT_REJECTION_THRESHOLDS
 * @returns {Promise<{ text: string, evalResult: Object, regenerated: boolean, queuedForReview: boolean }>}
 */
async function evaluateCandidates(
  candidates, context, profile, recentTexts, verifiedContext,
  apiConfig, buildPromptContextFn, regenerateFn, thresholds
) {
  thresholds = Object.assign({}, DEFAULT_REJECTION_THRESHOLDS, thresholds || {});
  var sourceText = (context && context.text) || "";

  /**
   * Runs full evaluation on a list of candidates:
   *   1. Heuristic screen (no API)
   *   2. LLM score (API call per candidate)
   * Returns sorted array with pass/fail status.
   */
  async function runEvaluationPass(candidateList) {
    var results = [];
    for (var i = 0; i < candidateList.length; i++) {
      var text = (candidateList[i] && candidateList[i].text) ? candidateList[i].text : "";
      if (!text) {
        results.push({ text: "", passed: false, failureTags: [FAILURE_TAGS.TOO_SHORT], composite: 0 });
        continue;
      }

      // Step 1: Heuristic screen
      var hScreen = heuristicScreen(text, sourceText, recentTexts, verifiedContext, thresholds);

      // Step 2: LLM evaluation (only if heuristic didn't immediately fail on UNSUPPORTED_CLAIM)
      var evalResult = null;
      try {
        evalResult = await evaluateCandidate(text, sourceText, profile, apiConfig, buildPromptContextFn);
      } catch (evalErr) {
        console.warn("[ReplyGenie] Evaluator LLM call failed for candidate " + i + ":", evalErr.message);
        // On LLM evaluator failure, rely on heuristics only — do not reject healthy replies
        evalResult = {
          scores:           { relevance: 8, specificity: 7, accuracy: 9, genericity: 2, conversation_value: 7, originality: 7, human_likeness: 7, voice_match: 7, question_necessity: 5 },
          composite:        7.0,
          hardRejectReason: null,
          llmRejectionReasons: [],
          failureTags:      [],
          promptVersion:    EVALUATOR_PROMPT_VERSION,
        };
      }

      var allFailureTags = hScreen.failureTags.concat(evalResult.failureTags)
        .filter(function(t, idx, a) { return a.indexOf(t) === idx; });

      var passed = allFailureTags.length === 0 && !evalResult.hardRejectReason &&
                   evalResult.composite >= thresholds.min_composite_score;

      results.push({
        text:         text,
        passed:       passed,
        failureTags:  allFailureTags,
        composite:    evalResult.composite,
        hardRejectReason: evalResult.hardRejectReason,
        evalResult:   evalResult,
        heuristicDetails: hScreen.details,
      });
    }
    return results.sort(function(a, b) { return b.composite - a.composite; });
  }

  // ── First pass ───────────────────────────────────────────────────────────
  var firstPassResults = await runEvaluationPass(candidates);
  var passing = firstPassResults.filter(function(r) { return r.passed; });

  if (passing.length > 0) {
    return { text: passing[0].text, evalResult: passing[0].evalResult, regenerated: false, queuedForReview: false };
  }

  // ── All 3 failed — collect failure reasons and regenerate once ────────────
  var allFailureReasons = [];
  firstPassResults.forEach(function(r) {
    r.failureTags.forEach(function(tag) {
      if (!allFailureReasons.includes(tag)) allFailureReasons.push(tag);
    });
    if (r.hardRejectReason) allFailureReasons.push(r.hardRejectReason);
  });

  var regenerated = false;
  if (typeof regenerateFn === "function") {
    try {
      var regenResult = await regenerateFn(allFailureReasons);
      if (regenResult && Array.isArray(regenResult.candidates) && regenResult.candidates.length > 0) {
        var secondPassResults = await runEvaluationPass(regenResult.candidates);
        var passingSecond     = secondPassResults.filter(function(r) { return r.passed; });
        regenerated = true;

        if (passingSecond.length > 0) {
          return { text: passingSecond[0].text, evalResult: passingSecond[0].evalResult, regenerated: true, queuedForReview: false };
        }

        // Second pass also failed — surface best candidate to human review queue
        var bestSecond = secondPassResults[0];
        _queueForHumanReview(context, bestSecond, allFailureReasons, secondPassResults);
        return { text: bestSecond.text, evalResult: bestSecond.evalResult, regenerated: true, queuedForReview: true };
      }
    } catch (regenErr) {
      console.warn("[ReplyGenie] Regeneration attempt failed:", regenErr.message);
    }
  }

  // ── No regeneration available — surface best to human review queue ────────
  var best = firstPassResults[0];
  _queueForHumanReview(context, best, allFailureReasons, firstPassResults);
  return { text: best.text, evalResult: best.evalResult, regenerated: regenerated, queuedForReview: true };
}

/**
 * Appends a failed-evaluation record to the human review queue in chrome.storage.local.
 * Non-blocking, fire-and-forget. Phase 11 will process this queue.
 */
function _queueForHumanReview(context, bestResult, failureReasons, allResults) {
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ [HUMAN_REVIEW_QUEUE_KEY]: [] }, function(data) {
        var queue = Array.isArray(data[HUMAN_REVIEW_QUEUE_KEY]) ? data[HUMAN_REVIEW_QUEUE_KEY] : [];
        queue.push({
          queued_at:      new Date().toISOString(),
          source_post_id: context && context.text ? context.text.slice(0, 80) : "unknown",
          best_candidate: bestResult && bestResult.text ? bestResult.text.slice(0, 200) : "",
          failure_reasons: failureReasons,
          all_results:     (allResults || []).map(function(r) {
            return { composite: r.composite, failureTags: r.failureTags };
          }),
        });
        // Keep last 50 items in queue
        var trimmed = queue.slice(-50);
        var update = {};
        update[HUMAN_REVIEW_QUEUE_KEY] = trimmed;
        chrome.storage.local.set(update, function() {});
      });
    }
  } catch (_) { /* non-critical */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Manual Rejection Recording (Phase 7 / Phase 9 training signal)
// ─────────────────────────────────────────────────────────────────────────────

var MANUAL_REJECTIONS_KEY = "manualRejections";

/**
 * Records a manual user rejection with failure taxonomy tag for Phase 9 training signal.
 * @param {Object} rejection - { source_post_id, reply_text, failure_tag, strategy, notes, scores }
 * @returns {Promise<Object>} recorded record
 */
function recordManualRejection(rejection) {
  return new Promise(function(resolve) {
    if (!rejection) return resolve(null);
    var tag = rejection.failure_tag || FAILURE_TAGS.GENERIC;
    if (!Object.values(FAILURE_TAGS).includes(tag)) {
      tag = FAILURE_TAGS.GENERIC;
    }
    var record = {
      id: "rej_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      rejected_at: new Date().toISOString(),
      source_post_id: rejection.source_post_id || "unknown",
      reply_text: rejection.reply_text || "",
      failure_tag: tag,
      strategy: rejection.strategy || null,
      scores: rejection.scores || null,
      notes: rejection.notes || null,
    };

    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({ [MANUAL_REJECTIONS_KEY]: [] }, function(data) {
          var list = Array.isArray(data[MANUAL_REJECTIONS_KEY]) ? data[MANUAL_REJECTIONS_KEY] : [];
          list.push(record);
          var trimmed = list.slice(-200); // Keep last 200 rejections for Phase 9
          var update = {};
          update[MANUAL_REJECTIONS_KEY] = trimmed;
          chrome.storage.local.set(update, function() {
            resolve(record);
          });
        });
      } else {
        resolve(record);
      }
    } catch (_) {
      resolve(record);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    EVALUATOR_PROMPT_VERSION,
    FAILURE_TAGS,
    DEFAULT_EVAL_WEIGHTS,
    DEFAULT_REJECTION_THRESHOLDS,
    FORCED_QUESTION_ENDINGS,
    GENERIC_PHRASES,
    detectForcedQuestion,
    computeGenericityScore,
    extractClaims,
    checkClaimSupport,
    checkAccuracy,
    ngramJaccard,
    bowCosine,
    detectDuplicate,
    detectRepeatedStructure,
    heuristicScreen,
    computeCompositeScore,
    evaluateCandidate,
    evaluateCandidates,
    recordManualRejection,
    EVALUATOR_SYSTEM_PROMPT,
    HUMAN_REVIEW_QUEUE_KEY,
    MANUAL_REJECTIONS_KEY,
  };
}
