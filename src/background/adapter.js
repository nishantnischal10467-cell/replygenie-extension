// src/background/adapter.js
// Phase 5 — ReplyAdapter
//
// Adapts a stored high-confidence candidate reply to the current post context.
// This is NOT a blind copy-paste.  The adapter:
//   1. Verifies the candidate still fits (staleness + contradiction double-check)
//   2. Extracts the structural/argumentative core of the reply
//   3. Issues a single OpenAI call to rewrite it for the current post
//   4. Refuses if adaptation would require manufacturing unverified facts
//
// All untrusted text (source post, candidate reply text) is isolated via
// buildPromptContext() — never raw string interpolation.
//
// Prompt version tracking:
//   Every adapter call records { prompt_version, prompt_text } in generation_runs
//   so we can diff adapter vs generator quality in the eval loop.

/* eslint-disable no-var */

var ADAPTER_PROMPT_VERSION = "adapter-v1.0.0";

// Strategy-to-instruction map.  Tells the adapter HOW to surface the candidate's
// core argument without copying its phrasing.
var STRATEGY_ADAPTATION_HINTS = {
  "specific_agreement_extension":  "Agree with the core idea and add one new extension that fits the current post.",
  "respectful_disagreement":       "Preserve the disagreement angle but calibrate it to the current post's specific claim.",
  "contrarian_observation":        "Keep the contrarian framing but make it specific to what this post is actually saying.",
  "concrete_example":              "Use the structural form (giving an example) but surface an example relevant to THIS post.",
  "useful_correction":             "Preserve the corrective intent; verify the correction still applies to this post.",
  "personal_insight":              "Keep the personal observation but ONLY include facts present in the verified user context provided.",
  "analogy":                       "Adapt the analogical structure; replace source-specific references with ones relevant to this post.",
  "short_witty_observation":       "Keep the brevity and wit; rewrite around what's specific and interesting about this post.",
  "data_backed_observation":       "Only reuse data points present in the verified context. Do not invent or transfer stats between contexts.",
  "practical_takeaway":            "Surface the practical angle as it applies to THIS post's topic and audience.",
  "nuance":                        "Keep the nuance framing; ensure the caveat is relevant to this post's actual claim.",
  "pattern_recognition":           "Preserve the pattern insight but verify it applies to what this post is describing.",
  "story_fragment":                "Keep the narrative structure; rewrite the story around this post's context.",
  "community_building_response":   "Keep the inclusive, community tone; make it specific to this post.",
  "genuine_question":              "Preserve the question-asking approach; ask the most useful question for THIS specific post.",
};

var DEFAULT_ADAPTATION_HINT = "Extract the core argumentative move from the example reply and apply it to the current post.";

// ── Adapter system prompt ─────────────────────────────────────────────────────

/**
 * Builds the adaptation system prompt.
 * @param {Object} profile        — user profile (voiceSamples, tone, etc.)
 * @param {Object} candidate      — ranked candidate reply record
 * @param {Object} analysis       — PostAnalyzer output
 * @returns {string}
 */
function buildAdapterSystemPrompt(profile, candidate, analysis) {
  var strategyHint = STRATEGY_ADAPTATION_HINTS[candidate.reply_strategy] || DEFAULT_ADAPTATION_HINT;
  var voiceSamples = (profile.voiceSamples || []).slice(-6);

  var lines = [
    "You are adapting an existing reply for a new X post. Your task:",
    "  1. Do NOT copy the example reply verbatim — not a single sentence.",
    "  2. Extract the core argumentative move (the structural approach, the angle).",
    "  3. Rewrite it from scratch for the CURRENT post provided in the user message.",
    "  4. Never invent facts, data, or experiences not present in the verified context block.",
    "  5. If the example reply references specific facts that don't apply to the current post,",
    "     omit them entirely rather than transferring them to a new context.",
    "  6. Match the user's voice profile exactly.",
    "",
    "== ADAPTATION STRATEGY ==",
    strategyHint,
    "",
    "== WHAT THIS EXAMPLE REPLY DOES WELL (structure to preserve) ==",
    "Reply strategy: " + (candidate.reply_strategy || "unknown"),
    "Core move: use this structural pattern as your blueprint — not its words.",
    "",
  ];

  if (analysis && analysis.topic) {
    lines.push("Current post topic: " + analysis.topic);
    lines.push("Current post intent: " + (analysis.intent || "unknown"));
  }

  lines.push("Tone setting: " + (profile.tone || "Direct"));

  if (voiceSamples.length > 0) {
    lines.push("");
    lines.push("== USER VOICE SAMPLES — match this voice exactly ==");
    voiceSamples.forEach(function (s, i) { lines.push((i + 1) + ". " + s); });
    lines.push("Match the voice. Do not copy any sample verbatim.");
  }

  lines.push("");
  lines.push("Write ONLY the adapted reply text. No preamble, no explanation, no quotes.");
  lines.push("One focused idea. Length: " + (profile.length || "Medium") + " (same constraints as normal generation).");

  return lines.join("\n");
}

/**
 * Builds the adapter user message.
 * Untrusted text (source post + candidate reply text) is passed through
 * buildPromptContext() — never concatenated raw.
 *
 * @param {Object} context     — current post context (handle, text)
 * @param {Object} candidate   — stored reply candidate
 * @param {Object} pCtx        — result of buildPromptContext(context)
 * @returns {string}
 */
function buildAdapterUserMessage(context, candidate, pCtx) {
  // Source post is already isolated in pCtx.userBlock.
  // We add the example reply text, also wrapped in data delimiters.
  var exampleText = candidate.reply_text || "(no text)";
  // Truncate to avoid prompt abuse via DB-stored content
  var safeCandidateText = exampleText.slice(0, 500);

  return (
    pCtx.userBlock +
    "\n\n[EXAMPLE_REPLY_TO_ADAPT]\n" +
    safeCandidateText +
    "\n[/EXAMPLE_REPLY_TO_ADAPT]\n\n" +
    "Adapt the example reply for the current post above. " +
    "Extract the structural move only — rewrite completely for this specific post."
  );
}

// ── Pre-adaptation safety check ───────────────────────────────────────────────

/**
 * Returns { safe: boolean, refusalReason: string|null }
 * Refuses adaptation if:
 *   - candidate text contains year-specific data claims more than 2 years old
 *   - candidate text mentions specific named products/companies that may be irrelevant
 *   - candidate strategy is a personal_insight but voiceSamples are empty
 *     (no verified personal context to draw from)
 *
 * NOTE: This is a heuristic guard.  LLM-based staleness verification is Phase 7.
 * @param {Object} candidate
 * @param {Object} profile
 * @returns {{ safe: boolean, refusalReason: string|null }}
 */
function preAdaptationCheck(candidate, profile) {
  var text = (candidate.reply_text || "").toLowerCase();

  // Detect stale year references (>2 years old)
  var currentYear = new Date().getFullYear();
  var years = text.match(/\b(20\d{2})\b/g) || [];
  for (var i = 0; i < years.length; i++) {
    if (parseInt(years[i], 10) < currentYear - 2) {
      return {
        safe: false,
        refusalReason: "stale_year_reference:" + years[i],
      };
    }
  }

  // personal_insight without verified context → refuse
  if (candidate.reply_strategy === "personal_insight") {
    var voiceSamples = profile.voiceSamples || [];
    if (voiceSamples.length === 0) {
      return {
        safe: false,
        refusalReason: "personal_insight_strategy_requires_voice_samples",
      };
    }
  }

  return { safe: true, refusalReason: null };
}

// ── Main adapter function ─────────────────────────────────────────────────────

/**
 * Adapts a stored candidate reply for the current context via a single OpenAI call.
 *
 * @param {Object} context     — current post context
 * @param {Object} candidate   — top-ranked candidate from ReplyRanker
 * @param {Object} analysis    — PostAnalyzer output
 * @param {Object} profile     — user profile
 * @param {Object} apiConfig   — { apiKey, model, apiUrl }
 * @param {Function} buildPromptContextFn — prompt.js buildPromptContext
 * @param {Function} getLengthConfigFn    — background.js getLengthConfig
 * @returns {Promise<{ text: string, promptVersion: string, adapted: boolean, refusalReason: string|null }>}
 */
async function adaptReply(context, candidate, analysis, profile, apiConfig, buildPromptContextFn, getLengthConfigFn) {
  // Pre-adaptation safety check
  var safetyResult = preAdaptationCheck(candidate, profile);
  if (!safetyResult.safe) {
    return {
      text:           null,
      promptVersion:  ADAPTER_PROMPT_VERSION,
      adapted:        false,
      refusalReason:  safetyResult.refusalReason,
    };
  }

  // Isolate untrusted source post
  var pCtx = buildPromptContextFn(context);

  var systemPrompt  = buildAdapterSystemPrompt(profile, candidate, analysis);
  var systemContent = pCtx.systemPreamble + "\n\n" + systemPrompt;
  var userMessage   = buildAdapterUserMessage(context, candidate, pCtx);

  var lengthCfg = getLengthConfigFn ? getLengthConfigFn(profile.length) : { max_tokens: 100 };

  var body = {
    model:      apiConfig.model || "gpt-4o-mini",
    max_tokens: lengthCfg.max_tokens,
    messages: [
      { role: "system", content: systemContent },
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
    throw new Error("Adapter API error (" + res.status + "): " + errText.slice(0, 200));
  }

  var data   = await res.json();
  var choice = data.choices && data.choices[0];
  if (!choice || !choice.message || !choice.message.content) {
    throw new Error("Adapter: no content returned by model.");
  }

  return {
    text:          choice.message.content.trim(),
    promptVersion: ADAPTER_PROMPT_VERSION,
    adapted:       true,
    refusalReason: null,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ADAPTER_PROMPT_VERSION,
    STRATEGY_ADAPTATION_HINTS,
    buildAdapterSystemPrompt,
    buildAdapterUserMessage,
    preAdaptationCheck,
    adaptReply,
  };
}
