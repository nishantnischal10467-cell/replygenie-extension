// src/background/generator.js
// Phase 5 — Two-Stage ReplyGenerator
//
// Stage 1 (Strategy Selection):
//   Given the source post analysis + retrieved context, determine the single
//   best reply strategy.  Returns a structured JSON strategy object.
//
// Stage 2 (Reply Generation):
//   Generate 3 candidate replies using the confirmed strategy, full voice
//   profile, historical performance examples, and all prompt constraints.
//   Returns all 3; background.js selects the one to surface to the user.
//
// All untrusted text (tweet content, bios, quoted tweets) is isolated via
// buildPromptContext() — never raw string interpolation.
//
// Prompt versioning:
//   Both stage prompts record their version id in generation_runs for eval
//   comparisons across prompt iterations.

/* eslint-disable no-var */

var GENERATOR_STAGE1_PROMPT_VERSION = "generator-stage1-v1.0.0";
var GENERATOR_STAGE2_PROMPT_VERSION = "generator-stage2-v1.0.0";

// ── Strategy catalogue ────────────────────────────────────────────────────────
// Canonical list the Stage 1 model selects from.
// Keys are what the model returns in JSON; descriptions shape its selection logic.

var REPLY_STRATEGIES = [
  {
    id:          "specific_agreement_extension",
    description: "Agree with a specific part of the post and extend it one useful step further.",
    usability:   "always",
  },
  {
    id:          "respectful_disagreement",
    description: "Politely push back on one specific claim or assumption in the post.",
    usability:   "always",
  },
  {
    id:          "contrarian_observation",
    description: "Offer a surprising or counterintuitive take that the post overlooked.",
    usability:   "always",
  },
  {
    id:          "concrete_example",
    description: "Provide a concrete, specific example that illustrates or challenges the post's point.",
    usability:   "always",
  },
  {
    id:          "useful_correction",
    description: "Correct a factual error or misleading framing in the post — constructively.",
    usability:   "always",
  },
  {
    id:          "personal_insight",
    description: "Share a genuine personal observation. ONLY if supported by verified user context provided.",
    usability:   "requires_voice_context",
  },
  {
    id:          "short_witty_observation",
    description: "A brief, sharp observation — witty without being flippant.",
    usability:   "always",
  },
  {
    id:          "data_backed_observation",
    description: "Cite a relevant data point, statistic, or ratio. Only use data present in verified context.",
    usability:   "always",
  },
  {
    id:          "practical_takeaway",
    description: "Provide one immediately actionable takeaway derived from the post's idea.",
    usability:   "always",
  },
  {
    id:          "nuance",
    description: "Add a caveat or nuance that makes the post's point more precisely true.",
    usability:   "always",
  },
  {
    id:          "pattern_recognition",
    description: "Identify the broader pattern or underlying dynamic that the post exemplifies.",
    usability:   "always",
  },
  {
    id:          "story_fragment",
    description: "Contribute a brief 1-2 sentence narrative that adds texture to the post's topic.",
    usability:   "always",
  },
  {
    id:          "community_building_response",
    description: "Acknowledge shared experience to connect with the poster and audience — no sycophancy.",
    usability:   "always",
  },
  {
    id:          "genuine_question",
    description: "Ask one specific, non-generic question. Use ONLY when a question is genuinely the most useful response.",
    usability:   "conditional",
  },
];

// ── Stage 1: Strategy selection ───────────────────────────────────────────────

/**
 * Builds the Stage 1 system prompt for strategy selection.
 * @param {Object} analysis — PostAnalyzer output
 * @param {Array}  rankedCandidates — top few ranked candidates for context
 * @returns {string}
 */
function buildStage1SystemPrompt(analysis, rankedCandidates) {
  var strategyList = REPLY_STRATEGIES.map(function (s, i) {
    return (i + 1) + ". id=\"" + s.id + "\" — " + s.description +
           (s.usability !== "always" ? " [" + s.usability.toUpperCase() + "]" : "");
  }).join("\n");

  var topCandidateInfo = "";
  if (rankedCandidates && rankedCandidates.length > 0) {
    var topStrategies = rankedCandidates
      .slice(0, 3)
      .filter(function (c) { return c.reply_strategy; })
      .map(function (c) { return c.reply_strategy + " (score:" + (c.candidate_score || 0).toFixed(2) + ")"; })
      .join(", ");
    if (topStrategies) {
      topCandidateInfo = "\nTop historically successful strategies for similar posts: " + topStrategies;
    }
  }

  return [
    "You are selecting the single best reply strategy for an X post.",
    "Your output MUST be valid JSON and nothing else — no markdown, no explanation.",
    "",
    "Available strategies:",
    strategyList,
    "",
    "Post analysis context:",
    "  topic: " + (analysis.topic || "unknown"),
    "  intent: " + (analysis.intent || "unknown"),
    "  sentiment: " + (analysis.sentiment || "unknown"),
    "  post_format: " + (analysis.post_format || "unknown"),
    "  conversational_opportunity: " + (analysis.conversational_opportunity || "unknown"),
    "  controversial: " + (!!analysis.controversial_claims),
    "  specific_facts: " + (!!analysis.specific_facts_or_numbers && analysis.specific_facts_or_numbers.length > 0),
    "  implied_question: " + (analysis.implied_question || "none"),
    topCandidateInfo,
    "",
    "Rules:",
    "  1. Select the strategy that creates the most genuinely useful reply for this specific post.",
    "  2. Do NOT select 'genuine_question' unless asking a question is clearly the best contribution.",
    "  3. Do NOT select 'personal_insight' unless verified user context is explicitly provided.",
    "  4. Do NOT select 'data_backed_observation' unless you will use a number already present in the post or context.",
    "  5. Never manufacture engagement. Never praise the author.",
    "",
    "Return JSON exactly:",
    "{",
    "  \"strategy_id\": \"<one of the ids above>\",",
    "  \"rationale\": \"<one sentence explaining why this is the best strategy for this post>\",",
    "  \"angle\": \"<one sentence describing the specific argumentative angle to take>\"",
    "}",
  ].join("\n");
}

/**
 * Calls OpenAI Stage 1 to select the reply strategy.
 *
 * @param {Object} context     — current post context
 * @param {Object} analysis    — PostAnalyzer output
 * @param {Array}  rankedCandidates
 * @param {Object} apiConfig   — { apiKey, model, apiUrl }
 * @param {Function} buildPromptContextFn
 * @returns {Promise<{ strategy_id, rationale, angle, promptVersion }>}
 */
async function selectStrategy(context, analysis, rankedCandidates, apiConfig, buildPromptContextFn) {
  var pCtx = buildPromptContextFn(context);

  var systemPrompt = pCtx.systemPreamble + "\n\n" + buildStage1SystemPrompt(analysis, rankedCandidates);

  var userMessage = pCtx.userBlock +
    "\n\nAnalyze this post and select the best reply strategy. Return only valid JSON.";

  var body = {
    model:      apiConfig.model || "gpt-4o-mini",
    max_tokens: 200, // Stage 1 only returns a small JSON object
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMessage },
    ],
  };

  var res = await fetch(apiConfig.apiUrl || "https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + apiConfig.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error("Stage1 API error (" + res.status + "): " + errText.slice(0, 200));
  }

  var data   = await res.json();
  var choice = data.choices && data.choices[0];
  if (!choice || !choice.message || !choice.message.content) {
    throw new Error("Stage1: no content returned.");
  }

  var raw = choice.message.content.trim();
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Graceful fallback: extract strategy_id with regex if JSON parse fails
    var match = raw.match(/"strategy_id"\s*:\s*"([^"]+)"/);
    parsed = {
      strategy_id: match ? match[1] : "specific_agreement_extension",
      rationale:   "JSON parse failed — used fallback extraction",
      angle:       "",
    };
  }

  // Validate strategy_id is in catalogue
  var validIds = REPLY_STRATEGIES.map(function (s) { return s.id; });
  if (!validIds.includes(parsed.strategy_id)) {
    parsed.strategy_id = "specific_agreement_extension"; // Safe fallback
    parsed.rationale   = "Invalid strategy_id returned — defaulted to safe fallback";
  }

  return Object.assign({}, parsed, { promptVersion: GENERATOR_STAGE1_PROMPT_VERSION });
}

// ── Stage 2: Reply generation ─────────────────────────────────────────────────

// This is the core generation system prompt from the Phase 5 spec.
// Version-pinned so eval can track quality across rewrites.

var GENERATION_SYSTEM_PROMPT_TEMPLATE = [
  "You are writing one authentic reply to an X post.",
  "Your job is not to praise the author.",
  "Your job is to contribute one genuinely useful thought.",
  "Read the post carefully.",
  "Identify the most interesting specific idea.",
  "Add something that was not already said.",
  "Prefer a clear observation, useful extension, concrete example, respectful disagreement, nuance, or concise insight.",
  "Do not restate the post.",
  "Do not begin with generic praise.",
  "Do not ask a question unless a question is genuinely useful.",
  "Never invent facts or personal experiences that are not present in the provided verified context.",
  "Never manufacture engagement.",
  "Write like a thoughtful person participating in a real community.",
  "One strong idea is better than three weak ones.",
  "Do not force a conclusion.",
  "Do not append 'thoughts?', 'agree?', or similar engagement bait.",
  "Use the provided voice profile without copying any historical example verbatim.",
].join("\n");

/**
 * Builds the Stage 2 system prompt for reply generation.
 * Injects: strategy, voice, historical examples, negative examples, constraints.
 *
 * @param {Object} profile           — user profile
 * @param {Object} strategyResult    — output of selectStrategy()
 * @param {Array}  rankedCandidates  — top candidates (for positive + negative examples)
 * @param {Array}  recentReplies     — recently posted reply texts (for anti-repetition)
 * @param {Object} lengthConfig      — { instruction, max_tokens }
 * @returns {string}
 */
function buildStage2SystemPrompt(profile, strategyResult, rankedCandidates, recentReplies, lengthConfig) {
  var lines = [
    GENERATION_SYSTEM_PROMPT_TEMPLATE,
    "",
    "== REPLY LENGTH (HIGHEST PRIORITY) ==",
    lengthConfig.instruction,
    "Violating the length constraint is a critical failure.",
    "",
    "== SELECTED STRATEGY ==",
    "Strategy: " + strategyResult.strategy_id,
    "Rationale: " + (strategyResult.rationale || ""),
    "Angle: " + (strategyResult.angle || ""),
    "",
    "== YOUR PROFILE ==",
    "Handle: " + (profile.handle || "(not provided)"),
    "About: " + (profile.aboutYou || "(not provided)"),
    "Tone: " + (profile.tone || "Direct"),
  ];

  if (profile.intentions)          lines.push("Goal: " + profile.intentions);
  if (profile.interests)           lines.push("Interests: " + profile.interests);
  if (profile.mentionWhenRelevant) lines.push("Mention when relevant: " + profile.mentionWhenRelevant);
  if (profile.neverMention)        lines.push("NEVER mention: " + profile.neverMention);

  // Voice samples (positive examples)
  var voiceSamples = (profile.voiceSamples || []).slice(-8);
  if (voiceSamples.length > 0) {
    lines.push("");
    lines.push("== VOICE PROFILE — your own replies, match this voice ==");
    voiceSamples.forEach(function (s, i) { lines.push((i + 1) + ". " + s); });
    lines.push("Match the voice. Do not copy any sample verbatim.");
  }

  // Positive historical examples (high-performance candidates with same strategy)
  var positiveExamples = (rankedCandidates || [])
    .filter(function (c) {
      return c.reply_strategy === strategyResult.strategy_id &&
             (c.performance_score || 0) > 0.4 &&
             c.reply_text;
    })
    .slice(0, 3);

  if (positiveExamples.length > 0) {
    lines.push("");
    lines.push("== SUCCESSFUL HISTORICAL EXAMPLES (same strategy, strong performance) ==");
    lines.push("These worked well. Use as inspiration for structure only — never copy.");
    positiveExamples.forEach(function (c, i) {
      lines.push((i + 1) + ". " + c.reply_text.slice(0, 200));
    });
  }

  // Negative examples (low-performance candidates — learn what not to do)
  var negativeExamples = (rankedCandidates || [])
    .filter(function (c) {
      return (c.performance_score || 1) < 0.1 && c.reply_text;
    })
    .slice(0, 2);

  if (negativeExamples.length > 0) {
    lines.push("");
    lines.push("== NEGATIVE EXAMPLES (poor performance — avoid these patterns) ==");
    negativeExamples.forEach(function (c, i) {
      lines.push((i + 1) + ". " + c.reply_text.slice(0, 200));
    });
  }

  // Anti-repetition: ban openers of recent replies
  var recentOpeners = (recentReplies || [])
    .slice(-10)
    .map(function (r) { return r.split(/\s+/).slice(0, 4).join(" "); })
    .filter(Boolean);

  if (recentOpeners.length > 0) {
    lines.push("");
    lines.push("== DO NOT START WITH ANY OF THESE (already used recently) ==");
    recentOpeners.forEach(function (op) { lines.push("- \"" + op + "...\""); });
    lines.push("Your reply MUST start with completely different words and structure.");
  }

  // Question probability constraint (10-20% by default per spec)
  var questionFrequency = (profile.question_frequency !== undefined)
    ? profile.question_frequency : 0.15;
  if (questionFrequency < 0.2) {
    lines.push("");
    lines.push("== QUESTION CONSTRAINT ==");
    lines.push("Target question probability: " + Math.round(questionFrequency * 100) + "% — avoid ending with a question for most replies.");
  }

  lines.push("");
  lines.push("== GENERATE 3 CANDIDATE REPLIES ==");
  lines.push("Return ONLY valid JSON. No markdown, no explanation, no code fences.");
  lines.push("{");
  lines.push("  \"candidates\": [");
  lines.push("    { \"text\": \"<reply 1>\" },");
  lines.push("    { \"text\": \"<reply 2>\" },");
  lines.push("    { \"text\": \"<reply 3>\" }");
  lines.push("  ]");
  lines.push("}");
  lines.push("Each candidate must be meaningfully different in angle, phrasing, and structure.");
  lines.push("REMINDER — " + lengthConfig.instruction);

  return lines.join("\n");
}

/**
 * Calls OpenAI Stage 2 to generate 3 candidate replies.
 *
 * @param {Object} context          — current post context
 * @param {Object} strategyResult   — output of selectStrategy()
 * @param {Object} analysis         — PostAnalyzer output
 * @param {Array}  rankedCandidates — ranked candidates for examples
 * @param {Array}  recentReplies    — recently posted reply texts
 * @param {Object} profile          — user profile
 * @param {Object} apiConfig        — { apiKey, model, apiUrl }
 * @param {Object} lengthConfig     — { instruction, max_tokens }
 * @param {Function} buildPromptContextFn
 * @param {Object} inspiredBy       — optional candidate used as inspiration (INSPIRE route)
 * @returns {Promise<{ candidates: Array<{text}>, promptVersion, strategyId }>}
 */
async function generateCandidates(
  context,
  strategyResult,
  analysis,
  rankedCandidates,
  recentReplies,
  profile,
  apiConfig,
  lengthConfig,
  buildPromptContextFn,
  inspiredBy
) {
  var pCtx = buildPromptContextFn(context);

  var systemPrompt = pCtx.systemPreamble + "\n\n" +
    buildStage2SystemPrompt(profile, strategyResult, rankedCandidates, recentReplies, lengthConfig);

  var userMessage = pCtx.userBlock;

  // INSPIRE path: append the inspiration candidate in a delimited block
  if (inspiredBy && inspiredBy.reply_text) {
    var safeInspirationText = inspiredBy.reply_text.slice(0, 400);
    userMessage +=
      "\n\n[INSPIRATION_REPLY — structural reference only, do not copy]\n" +
      safeInspirationText +
      "\n[/INSPIRATION_REPLY]\n\n" +
      "Use the structural approach of the inspiration reply but rewrite completely for this specific post.";
  }

  userMessage += "\n\nGenerate 3 candidate replies. Return valid JSON only.";

  // Stage 2 tokens = 3 candidates × max_tokens per candidate
  var stage2MaxTokens = (lengthConfig.max_tokens || 100) * 3 + 50; // +50 for JSON overhead

  var body = {
    model:      apiConfig.model || "gpt-4o-mini",
    max_tokens: Math.min(stage2MaxTokens, 800), // hard cap to avoid runaway cost
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMessage },
    ],
  };

  var res = await fetch(apiConfig.apiUrl || "https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + apiConfig.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error("Stage2 API error (" + res.status + "): " + errText.slice(0, 200));
  }

  var data   = await res.json();
  var choice = data.choices && data.choices[0];
  if (!choice || !choice.message || !choice.message.content) {
    throw new Error("Stage2: no content returned.");
  }

  var raw = choice.message.content.trim();
  // Strip possible markdown code fences before parsing
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Fallback: try to extract text fields with regex
    var texts = [];
    var textRe = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    var m;
    while ((m = textRe.exec(raw)) !== null) {
      texts.push(m[1].replace(/\\n/g, "\n").replace(/\\"/g, "\""));
    }
    if (texts.length > 0) {
      parsed = { candidates: texts.map(function (t) { return { text: t }; }) };
    } else {
      // Last resort: treat whole content as a single reply
      parsed = { candidates: [{ text: raw }] };
    }
  }

  var candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  if (candidates.length === 0) {
    // If model returned text directly instead of JSON array
    candidates = [{ text: raw }];
  }

  // Sanitise: ensure each candidate has a non-empty text field
  candidates = candidates
    .filter(function (c) { return c && c.text && c.text.trim().length > 0; })
    .slice(0, 3);

  if (candidates.length === 0) {
    throw new Error("Stage2: all generated candidates were empty.");
  }

  return {
    candidates:    candidates,
    promptVersion: GENERATOR_STAGE2_PROMPT_VERSION,
    strategyId:    strategyResult.strategy_id,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    GENERATOR_STAGE1_PROMPT_VERSION,
    GENERATOR_STAGE2_PROMPT_VERSION,
    GENERATION_SYSTEM_PROMPT_TEMPLATE,
    REPLY_STRATEGIES,
    buildStage1SystemPrompt,
    selectStrategy,
    buildStage2SystemPrompt,
    generateCandidates,
  };
}
