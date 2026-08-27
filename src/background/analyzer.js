// src/background/analyzer.js
// PostAnalyzer: extracts multi-dimensional semantic comprehension signals from X posts.
// MUST use buildPromptContext() for LLM prompts — NEVER interpolate source text directly.

/* eslint-disable no-var */

if (typeof buildPromptContext === "undefined" && typeof require !== "undefined") {
  var promptUtils = require("./prompt");
  var buildPromptContext = promptUtils.buildPromptContext;
}

var ANALYZER_MODEL = "gpt-4o-mini";
var ANALYZER_API_URL = "https://api.openai.com/v1/chat/completions";

var TOPIC_HEURISTICS = [
  { topic: "ai",           re: /\b(ai|llm|gpt|claude|rag|openai|model|neural|agent|prompt|machine learning)\b/i },
  { topic: "saas_builder", re: /\b(saas|mrr|arr|launch|shipped|build in public|bootstrapping|founder|product|mvp|indie hacker)\b/i },
  { topic: "marketing",    re: /\b(marketing|growth|distribution|seo|conversion|funnel|copywriting|audience|newsletter|email)\b/i },
  { topic: "branding",     re: /\b(brand|personal brand|reputation|content creator|followers|impressions|authority)\b/i },
  { topic: "engineering",  re: /\b(code|react|rust|python|typescript|backend|frontend|database|api|architecture|deploy)\b/i },
  { topic: "productivity", re: /\b(habit|focus|discipline|routine|deep work|time management|burnout|rest)\b/i },
  { topic: "finance",      re: /\b(vc|funding|investor|valuation|revenue|profit|margin|angel|capital)\b/i },
];

/**
 * Fast deterministic heuristic analyzer used for offline evaluation,
 * tests, and when API key is unavailable.
 * @param {Object} context
 * @returns {Object} analysis output
 */
function analyzePostHeuristic(context) {
  var text = (context && context.text) ? String(context.text) : "";
  var handle = (context && context.handle) ? String(context.handle) : "";
  var displayName = (context && context.displayName) ? String(context.displayName) : "";

  // 1. Topic
  var topic = "general";
  for (var i = 0; i < TOPIC_HEURISTICS.length; i++) {
    if (TOPIC_HEURISTICS[i].re.test(text)) {
      topic = TOPIC_HEURISTICS[i].topic;
      break;
    }
  }

  // 2. Entities (handles, hashtags, capitalised words, tech terms)
  var entities = [];
  var hashtags = text.match(/#\w+/g) || [];
  var mentions = text.match(/@\w+/g) || [];
  entities = entities.concat(hashtags, mentions);

  var techMatches = text.match(/\b(OpenAI|GPT-4|Claude|Rust|Python|React|SaaS|Stanford|TypeScript|Vercel)\b/gi) || [];
  techMatches.forEach(function (t) {
    if (entities.indexOf(t) === -1) entities.push(t);
  });

  // 3. Specific facts or numbers
  var specificFactsOrNumbers = [];
  var numbers = text.match(/\b\d+(\.\d+)?(%|[a-zA-Z]+)?/g) || [];
  numbers.forEach(function (n) {
    if (n && n.length >= 1 && specificFactsOrNumbers.indexOf(n) === -1) {
      specificFactsOrNumbers.push(n);
    }
  });

  // 4. Claims & controversial claims
  var claims = [];
  var controversialClaims = [];
  var sentences = text.split(/[.!?\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);

  sentences.forEach(function (sentence) {
    if (sentence.length > 15) {
      claims.push(sentence);
      if (/\b(unpopular opinion|hot take|the truth is|lie|scam|wrong|overrated|underrated|never|always)\b/i.test(sentence)) {
        controversialClaims.push(sentence);
      }
    }
  });

  // 5. Sentiment
  var sentiment = "neutral";
  if (/\b(hate|terrible|broken|worst|mistake|lie|scam|exhausted|failing)\b/i.test(text)) {
    sentiment = "negative";
  } else if (/\b(love|amazing|shipped|hit|finally|congrats|grateful|incredible|exciting)\b/i.test(text)) {
    sentiment = "positive";
  } else if (controversialClaims.length > 0) {
    sentiment = "provocative";
  }

  // 6. Intent
  var intent = "thought_share";
  if (/\?/.test(text)) {
    intent = "question";
  } else if (/\b(shipped|launched|we are live|hit \d+|finally)\b/i.test(text)) {
    intent = "announcement";
  } else if (/\b(thanks|grateful|appreciate|shoutout)\b/i.test(text)) {
    intent = "celebration";
  } else if (/\b(unpopular opinion|hot take|is a lie|overengineered)\b/i.test(text)) {
    intent = "critique";
  } else if (/\b(tip|rule|advice|lesson|how to)\b/i.test(text)) {
    intent = "advice";
  }

  // 7. Post format
  var postFormat = "single_thought";
  if (text.includes("🧵") || /\bthread\b/i.test(text)) {
    postFormat = "thread_starter";
  } else if (/\?$/.test(text.trim())) {
    postFormat = "question";
  } else if (context && context.hasVideo) {
    postFormat = "media_highlight";
  } else if (sentences.length >= 3) {
    postFormat = "listicle_or_story";
  }

  // 8. Author type
  var authorType = "creator";
  if (/\b(founder|ceo|building|shipped|mrr)\b/i.test(text + " " + displayName)) {
    authorType = "founder";
  } else if (/\b(engineer|dev|code|rust|python|backend|repo)\b/i.test(text + " " + displayName)) {
    authorType = "engineer";
  } else if (/\b(marketing|growth|seo|copywriter|audience)\b/i.test(text + " " + displayName)) {
    authorType = "marketer";
  } else if (/\b(vc|angel|investing|fund)\b/i.test(text + " " + displayName)) {
    authorType = "investor";
  }

  // 9. Implied question
  var impliedQuestion = "What has been your experience with this?";
  if (/\?/.test(text)) {
    var qMatch = text.match(/[^.!?\n]+\?/);
    if (qMatch) impliedQuestion = qMatch[0].trim();
  } else if (controversialClaims.length > 0) {
    impliedQuestion = "Do you agree or disagree with this take?";
  } else if (intent === "announcement") {
    impliedQuestion = "What was the hardest hurdle or milestone to get here?";
  }

  // 10. Likely audience
  var likelyAudience = topic === "saas_builder" ? "Indie founders & startup builders" :
                       topic === "ai"           ? "AI engineers & practitioners" :
                       topic === "marketing"    ? "Marketers & growth operators" :
                       topic === "engineering"  ? "Software developers" : "General tech community";

  // 11. Conversational opportunity
  var conversationalOpportunity = "Expand on the central claim with a specific nuance or practical takeaway.";
  if (controversialClaims.length > 0) {
    conversationalOpportunity = "Politely challenge the absolute premise with a counterexample.";
  } else if (specificFactsOrNumbers.length > 0) {
    conversationalOpportunity = "Ask about the methodology or secondary metric behind these numbers.";
  } else if (intent === "announcement") {
    conversationalOpportunity = "Congratulate and ask about the key bottleneck solved.";
  }

  // 12. Possible reply angles
  var possibleReplyAngles = [
    "first_principles_expansion",
    "curious_metric_question",
    "contrarian_reframe",
  ];
  if (controversialClaims.length > 0) {
    possibleReplyAngles.unshift("nuanced_disagreement");
  } else if (intent === "announcement") {
    possibleReplyAngles = ["celebration_with_depth_question", "distribution_followup", "build_story_inquiry"];
  }

  return {
    topic: topic,
    entities: entities,
    claims: claims,
    sentiment: sentiment,
    intent: intent,
    post_format: postFormat,
    author_type: authorType,
    conversational_opportunity: conversationalOpportunity,
    controversial_claims: controversialClaims,
    specific_facts_or_numbers: specificFactsOrNumbers,
    implied_question: impliedQuestion,
    likely_audience: likelyAudience,
    possible_reply_angles: possibleReplyAngles,
    analysis_mode: "heuristic",
  };
}

/**
 * Full PostAnalyzer: extracts semantic comprehension signals.
 * Uses buildPromptContext() to guarantee prompt isolation.
 * Falls back to analyzePostHeuristic() when API key is missing or on error.
 *
 * @param {Object} context - { text, handle, displayName, images, hasVideo }
 * @param {string} [apiKey]
 * @param {Object} [options]
 * @returns {Promise<Object>} complete analysis
 */
async function analyzePost(context, apiKey, options) {
  options = options || {};

  // If no API key provided or heuristic mode requested, return heuristic directly
  if (!apiKey || options.forceHeuristic) {
    return analyzePostHeuristic(context);
  }

  // MANDATORY: Use buildPromptContext() for source tweet isolation
  var promptCtx = buildPromptContext(context);

  var systemPrompt = [
    promptCtx.systemPreamble,
    "",
    "You are an expert social media conversation analyzer.",
    "Analyze the provided post data and return ONLY a valid JSON object with these EXACT keys:",
    "{",
    '  "topic": string (e.g. "ai", "saas_builder", "marketing", "branding", "engineering", "productivity", "finance", "general"),',
    '  "entities": string[] (named entities, technologies, products, people),',
    '  "claims": string[] (explicit assertions made in the text),',
    '  "sentiment": string ("positive"|"negative"|"neutral"|"skeptical"|"enthusiastic"|"provocative"),',
    '  "intent": string ("announcement"|"question"|"discussion_starter"|"critique"|"celebration"|"advice"|"story"),',
    '  "post_format": string ("single_thought"|"thread_starter"|"listicle"|"question"|"media_highlight"),',
    '  "author_type": string ("founder"|"engineer"|"marketer"|"creator"|"investor"|"casual_user"),',
    '  "conversational_opportunity": string (the highest leverage conversational hook),',
    '  "controversial_claims": string[] (polarizing or debate-provoking statements),',
    '  "specific_facts_or_numbers": string[] (metrics, percentages, stats mentioned),',
    '  "implied_question": string (the subtle question or prompt to the reader),',
    '  "likely_audience": string (target audience for this post),',
    '  "possible_reply_angles": string[] (3-4 specific strategic angles to reply with)',
    "}",
  ].join("\n");

  try {
    var res = await fetch(ANALYZER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: ANALYZER_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: promptCtx.userBlock },
        ],
        temperature: 0.2,
      }),
    });

    if (res.ok) {
      var data = await res.json();
      var rawJson = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (rawJson) {
        var parsed = JSON.parse(rawJson);
        parsed.analysis_mode = "llm_structured";
        parsed.injection_flagged = promptCtx.injectionFlagged;
        return parsed;
      }
    }
  } catch (err) {
    console.warn("[ReplyGenie] LLM PostAnalyzer error, falling back to heuristic:", err.message);
  }

  // Graceful fallback
  var fallback = analyzePostHeuristic(context);
  fallback.injection_flagged = promptCtx.injectionFlagged;
  return fallback;
}

// Node.js / Jest exports
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ANALYZER_MODEL,
    analyzePostHeuristic,
    analyzePost,
  };
}
