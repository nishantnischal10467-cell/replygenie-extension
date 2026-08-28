// background.js — MV3 service worker

// Load shared modules — order matters: templates first (no deps), then Phase 1 safety rails, then Phase 2 DB layer.
importScripts("templates.js"); // TEMPLATES, INTENT_PATTERNS, BROAD_CATEGORY_PATTERNS
importScripts("flags.js");     // getFlags(), DEFAULT_FLAGS
importScripts("governor.js");  // checkGovernor(), recordGovernorEvent()
importScripts("logger.js");    // logTrace()
importScripts("prompt.js");    // buildPromptContext(), makeSourcePostId(), extractFirstName()
importScripts("db/schema.js");
importScripts("db/migrations.js");
importScripts("db/database.js");
importScripts("db/retention.js");
importScripts("embeddings.js"); // cosineSimilarity, generateEmbedding
importScripts("analyzer.js");   // PostAnalyzer
importScripts("retriever.js");  // ReplyRetriever
importScripts("pacer.js");      // X-side PacingEngine
importScripts("ranker.js");     // Phase 4: ReplyRanker (performance-aware ranking)
importScripts("router.js");     // Phase 5: Confidence Router (ADAPT / INSPIRE / GENERATE)
importScripts("adapter.js");    // Phase 5: ReplyAdapter (high-confidence candidate adaptation)
importScripts("generator.js");  // Phase 5: Two-stage ReplyGenerator (strategy select + generation)
importScripts("evaluator.js");  // Phase 6: Quality / Accuracy / Genericity Gate (evaluation & regeneration)

if (typeof initRetentionSchedule === "function") {
  initRetentionSchedule();
}

const API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL   = "gpt-4o-mini";

// ---------- Messaging listeners (MV3-safe for async work & service worker wakeups) ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GENERATE_REPLY") {
    generateReply(message.context)
      .then((res) => {
        if (typeof res === "object" && res !== null && res.reply) {
          sendResponse({ reply: res.reply, meta: res.meta });
        } else {
          sendResponse({ reply: res, meta: null });
        }
      })
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true; // Keep channel open for async sendResponse
  }
  if (message.type === "LEARN_FROM_REPLY") {
    learnFromReply(message.replyText)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (message.type === "RECORD_MANUAL_REJECTION") {
    recordManualRejection(message.rejection)
      .then((rec) => sendResponse({ ok: true, record: rec }))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "reply-genie") return;

  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });

  port.onMessage.addListener(async (message) => {
    if (message.type === "GENERATE_REPLY") {
      try {
        const res = await generateReply(message.context);
        if (!disconnected) {
          if (typeof res === "object" && res !== null && res.reply) {
            port.postMessage({ reply: res.reply, meta: res.meta });
          } else {
            port.postMessage({ reply: res, meta: null });
          }
        }
      } catch (err) {
        console.error("[ReplyGenie] generateReply failed:", err);
        if (!disconnected) port.postMessage({ error: err.message || String(err) });
      }
    }
    if (message.type === "LEARN_FROM_REPLY") {
      try {
        await learnFromReply(message.replyText);
        if (!disconnected) port.postMessage({ ok: true });
      } catch (err) {
        if (!disconnected) port.postMessage({ error: err.message || String(err) });
      }
    }
    if (message.type === "RECORD_MANUAL_REJECTION") {
      try {
        const rec = await recordManualRejection(message.rejection);
        if (!disconnected) port.postMessage({ ok: true, record: rec });
      } catch (err) {
        if (!disconnected) port.postMessage({ error: err.message || String(err) });
      }
    }
  });
});


// ---------- Profile ----------

function getProfile() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ profile: null }, (data) => {
      resolve(data.profile || {});
    });
  });
}

// ---------- Voice learning ----------

async function learnFromReply(replyText) {
  const profile = (await getProfile()) || {};
  const samples = Array.isArray(profile.voiceSamples) ? profile.voiceSamples : [];
  samples.push(replyText);
  const trimmed = samples.slice(-15);
  await new Promise((resolve) => {
    chrome.storage.sync.set({ profile: { ...profile, voiceSamples: trimmed } }, resolve);
  });
}

// ---------- Reply history (anti-repetition) ----------

function getRecentReplies() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ recentReplies: [] }, (data) => {
      resolve(Array.isArray(data.recentReplies) ? data.recentReplies : []);
    });
  });
}

async function saveRecentReply(reply) {
  const recent = await getRecentReplies();
  recent.push(reply);
  const trimmed = recent.slice(-20); // keep last 20 AI-generated replies
  await new Promise((resolve) => {
    chrome.storage.local.set({ recentReplies: trimmed }, resolve);
  });
}

// ---------- Reply angle rotation ----------
// 25 distinct structural angles — NO analogies, NO similes.
// Each angle forces a completely different sentence structure.

const REPLY_ANGLES = [
  // Question angles
  { id: 0, text: "Ask one specific question about what happens next — something that proves you actually read the post, not a generic 'what do you think?' question." },
  { id: 1, text: "Ask about a specific constraint, trade-off, or unexpected bottleneck encountered while doing this." },
  { id: 2, text: "Ask about the edge case or the one scenario where this breaks down." },
  { id: 3, text: "Ask a question that reveals the hidden assumption in the post." },
  { id: 4, text: "Ask what metric or signal they're using to know this is actually working." },

  // Opinion / take angles
  { id: 5, text: "State the one thing most people get wrong about this topic — be direct, no preamble." },
  { id: 6, text: "Agree with the point but name the one condition where it stops being true." },
  { id: 7, text: "Disagree with a specific part — not the whole post, just one assumption." },
  { id: 8, text: "Name the real reason this works that the post didn't mention." },
  { id: 9, text: "State what's obvious to people who've been doing this a while but surprising to newcomers." },

  // Personal experience angles
  { id: 10, text: "Share one specific thing you tried that relates to this — 1 sentence, concrete detail, no fluff." },
  { id: 11, text: "Describe what this looked like in practice for you — not the theory, the actual experience." },
  { id: 12, text: "Name the moment this clicked for you — be specific about when and why." },

  // Data / reframe angles
  { id: 13, text: "Give a concrete number, stat, or ratio that makes the point more tangible." },
  { id: 14, text: "Name the follow-on problem that shows up after this one gets solved." },
  { id: 15, text: "Describe what the failure mode of this approach actually looks like — be specific." },
  { id: 16, text: "Name who this doesn't work for and why — be precise about the exception." },

  // Pattern / insight angles
  { id: 17, text: "Name the underlying pattern behind what the post describes — what category of problem is this really?" },
  { id: 18, text: "Say what the post is actually about underneath the surface topic." },
  { id: 19, text: "Give the honest 'yes, and' — validate the point then extend it one step further." },
  { id: 20, text: "Point out the tradeoff nobody is mentioning — what do you give up to get this?" },

  // Context angles
  { id: 21, text: "Add a time dimension — how does this change 6 months from now vs today?" },
  { id: 22, text: "Name what separates the people who succeed at this from those who don't — be specific." },
  { id: 23, text: "Give the harder version of this — what does it look like when you're tired and it's not working?" },
  { id: 24, text: "State what you'd add to this if you had one more sentence to say something true." },
];

/**
 * Picks a reply angle, avoiding the last 8 used indices stored in chrome.storage.local.
 */
async function pickAngle() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ usedAngleIds: [] }, (data) => {
      const usedIds = new Set(data.usedAngleIds || []);
      // Filter out recently used angles
      const available = REPLY_ANGLES.filter((a) => !usedIds.has(a.id));
      // If somehow all are used, reset and use full list
      const pool = available.length > 0 ? available : REPLY_ANGLES;
      const chosen = pool[Math.floor(Math.random() * pool.length)];

      // Save this angle id to the used list (keep last 8)
      const updatedUsed = [...data.usedAngleIds, chosen.id].slice(-8);
      chrome.storage.local.set({ usedAngleIds: updatedUsed });

      resolve(chosen.text);
    });
  });
}

/**
 * Extracts the opening 3–4 words from each recent reply to build a dynamic
 * banned-opener list that updates after every generation.
 */
function extractRecentOpeners(recentReplies) {
  return recentReplies
    .slice(-10)
    .map((r) => r.split(/\s+/).slice(0, 4).join(" "))
    .filter(Boolean);
}

// ---------- Template helpers ----------
// NOTE: extractFirstName() is now defined in prompt.js (importScripts above).
// It is available as a global here — no redeclaration needed.

/**
 * Picks a random item from an array.
 */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Detects if the post matches a direct-template category (connect / thanks / congrats).
 * Returns the category key or null.
 */
function detectTemplateIntent(text) {
  const t = text.toLowerCase();
  for (const pattern of INTENT_PATTERNS) {
    if (pattern.test(t)) return pattern.category;
  }
  return null;
}

/**
 * Detects a broad topic category for AI tone guidance.
 * Returns the category key or null.
 */
function detectBroadCategory(text) {
  const t = text.toLowerCase();
  for (const pattern of BROAD_CATEGORY_PATTERNS) {
    if (pattern.test(t)) return pattern.category;
  }
  return null;
}

// ---------- Length config ----------

function getLengthConfig(length) {
  switch ((length || "Medium").trim()) {
    case "Short":
      return {
        instruction: "LENGTH: Short — STRICT MAXIMUM 10 words. One punchy clause. Stop immediately after the first complete thought. Do NOT write a second sentence under any circumstances.",
        max_tokens: 40,
      };
    case "Long":
      return {
        instruction: "LENGTH: Long — Write 3-4 sentences, 50-80 words. Add context, a follow-up thought, or a brief personal observation. Still no filler — every sentence must earn its place.",
        max_tokens: 220,
      };
    case "Medium":
    default:
      return {
        instruction: "LENGTH: Medium — 1-2 sentences, 15-30 words. Make the first sentence the whole point; the second (if any) adds something, not just restates.",
        max_tokens: 100,
      };
  }
}

// ---------- Prompt builders ----------

function buildSystemPrompt(profile, broadCategory, recentReplies, angle, activeTemplates) {
  const lengthCfg = getLengthConfig(profile.length);
  const recentOpeners = extractRecentOpeners(recentReplies);

  const lines = [
    "You are drafting a single reply to a post on X (Twitter) on behalf of a real person.",
    "Write ONLY the reply text — no quotes, no label, no preamble, no explanation.",
    "",
    // Length is the FIRST rule — position matters for model compliance
    `== REPLY LENGTH (HIGHEST PRIORITY RULE) ==`,
    lengthCfg.instruction,
    "Violating the length constraint is a critical failure, even if the reply is otherwise good.",
    "",
    "== CORE GOAL ==",
    "Sound like a real human who has an opinion, a memory, or a genuine reaction — not a bot completing a task.",
    "The reply should feel like it came from someone scrolling their feed and pausing on this post.",
    "",
    "== BANNED OPENERS & CLICHÉ PHRASES — NEVER start a reply or use any of these ==",
    "Single-word reactions: Right, Yeah, Yep, Nope, True, Fact, Facts, Same, Agreed, Correct, Exactly, Totally, Absolutely, Definitely, Seriously, Honestly, Clearly, Obviously, Literally",
    "Hollow affirmations: Great, Nice, Wow, Cool, Amazing, Incredible, Brilliant, Perfect, Wonderful, Love this, This is so true, So true, Well said, Such a great point, I completely agree",
    "Filler openers: Right?, Ha!, Haha, Lol, OMG, Oh wow, Oh man, Oh no, Indeed, Interesting, That's, It's like, This is like",
    "Life-coach & generic boilerplate questions/phrases (STRICTLY FORBIDDEN): 'What would you change if starting fresh today?', 'What would you do differently if starting over?', 'If you were starting over', 'What's next?', 'Keep shipping', 'So proud', 'This is inspiring', 'You got this'",
    "Simile/analogy openers (STRICTLY FORBIDDEN): 'That's like...', 'It's like...', 'This is like...', 'Think of it as...', 'Imagine if...', 'Kind of like...'",
    "RULE: Do NOT start with ANY single word followed by punctuation (Right!, Yeah., True,). Jump straight into the substance.",
    "",
    "== ALSO NEVER USE ==",
    "- Similes or analogies of ANY kind — no 'That's like', 'It's like', 'Imagine', 'Think of it as'",
    "- Corporate/therapy speak: 'resonate', 'impactful', 'leverage', 'game-changer', 'unpack', 'dive into', 'journey', 'space', 'authentic'",
    "- More than one emoji — most replies need zero",
    "- Symmetrical lists or structured breakdowns",
    "",
    "== WHAT TO DO INSTEAD — pick ONE that fits naturally ==",
    "1. Start mid-thought with your actual take: 'The launch high fades fast, the daily habit is what compounds.'",
    "2. Ask a sharp follow-up that shows you read it: 'What's the plan to get users now that it's live?'",
    "3. Share a short, specific personal experience: 'Tried this for a month — the hard part isn't doing it once, it's not skipping it on the day you're tired.'",
    "4. Offer a reframe or data point: '10k MRR after 2 years is roughly $27/day compounding — proof patience beats speed.'",
    "5. Poke a gentle hole in the premise: 'Does that hold if you're not a morning person though?'",
    "6. One-liner that adds something — not just an echo: 'Most side projects never ship, let alone in 6 months.'",
    "",
    "== STYLE ==",
    "- Start with a noun, verb, or clause — never with a reaction word",
    "- Contractions are good. Full stops over exclamation marks.",
    "- If niche/technical, show familiarity — don't explain the topic back to them",
    "",
    `User handle: ${profile.handle || "(not provided)"}`,
    `About the user: ${profile.aboutYou || "(not provided)"}`,
  ];

  if (profile.intentions)          lines.push(`What they want replies to accomplish: ${profile.intentions}`);
  if (profile.interests)           lines.push(`Topics/interests: ${profile.interests}`);
  if (profile.mentionWhenRelevant) lines.push(`Mention when relevant: ${profile.mentionWhenRelevant}`);
  if (profile.neverMention)        lines.push(`NEVER mention: ${profile.neverMention}`);

  lines.push(`Tone: ${profile.tone || "Witty"}`);

  // Inject category-specific example replies as tone guidance
  const tPool = activeTemplates || TEMPLATES;
  if (broadCategory && tPool[broadCategory]) {
    lines.push("");
    lines.push(`== TOPIC CATEGORY: ${broadCategory.toUpperCase()} — example replies in this style ==`);
    const examples = tPool[broadCategory].slice(0, 4);
    examples.forEach((ex, i) => lines.push(`${i + 1}. ${ex}`));
    lines.push("Match the directness and voice of these examples, but write something original for this specific post.");
  }

  if (profile.voiceSamples && profile.voiceSamples.length > 0) {
    lines.push("");
    lines.push("== VOICE SAMPLES (the user's own replies — match this voice exactly) ==");
    profile.voiceSamples.slice(-8).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }

  // Dynamic anti-repetition: ban the opening phrases of the last 10 replies
  if (recentOpeners.length > 0) {
    lines.push("");
    lines.push("== DO NOT START WITH ANY OF THESE (already used recently) ==");
    recentOpeners.forEach((op) => lines.push(`- "${op}..."`));
    lines.push("Your reply MUST begin with completely different words and a different sentence structure.");
  }

  // Forced variety angle — a different structural approach every request
  lines.push("");
  lines.push(`== YOUR APPROACH FOR THIS REPLY (mandatory) ==`);
  lines.push(angle);
  lines.push("Do not deviate from this structural approach.");

  lines.push("");
  // Repeat length rule at the end so it's the last thing the model reads before generating
  lines.push(`REMINDER — ${lengthCfg.instruction}`);
  lines.push("Now write ONE reply.");

  return lines.join("\n");
}

function buildUserMessage(context) {
  let desc = "Post to reply to:\n";
  desc += `Author: ${context.handle || "unknown"}\n`;
  desc += `Text: ${context.text || "(no text — media-only post)"}\n`;
  if (context.images && context.images.length > 0) desc += `(post has ${context.images.length} image(s) — not shown)\n`;
  if (context.hasVideo) desc += "(post has a video)\n";
  desc += "\nWrite the reply now.";
  return desc;
}

// ---------- Main reply generator ----------

async function generateReply(context) {
  const _t0 = Date.now();

  // ── Load feature flags — determines which Phase 1 rails are active ──────
  // When all flags are false (default), execution is byte-for-byte identical
  // to the pre-Phase-1 behaviour.
  const _flags = await getFlags();

  const firstName = extractFirstName(context); // defined in prompt.js
  const tweetText = context.text || "";

  const profile = await getProfile();

  // Active template pool (merged user custom database + default templates)
  const activeTemplates = typeof getMergedTemplates === "function"
    ? getMergedTemplates(profile.customTemplates)
    : TEMPLATES;

  // ── 1. Template short-circuit ──────────────────────────────────────────
  const templateCategory = detectTemplateIntent(tweetText);
  if (templateCategory && activeTemplates[templateCategory] && activeTemplates[templateCategory].length > 0) {
    const template = pickRandom(activeTemplates[templateCategory]);
    const templateReply = fillTemplate(template, firstName);

    if (_flags.ENABLE_DECISION_LOGGING) {
      logTrace({
        source_post_id:    makeSourcePostId(context),
        decision_path:     "template:" + templateCategory,
        model_version:     "template",
        outcome:           "success",
        latency_ms:        Date.now() - _t0,
        injection_flagged: false,
      }).catch(() => {});
    }

    return templateReply;
  }

  // ── 2. AI generation ────────────────────────────────────────────────────

  // Governor check — flag-gated. When ENABLE_RATE_GOVERNOR is false, no cap applied.
  if (_flags.ENABLE_RATE_GOVERNOR) {
    const _gov = await checkGovernor();
    if (!_gov.allowed) {
      if (_flags.ENABLE_DECISION_LOGGING) {
        logTrace({
          source_post_id:    makeSourcePostId(context),
          decision_path:     "ai:rate_limited",
          model_version:     MODEL,
          outcome:           "rate_limited",
          latency_ms:        Date.now() - _t0,
          injection_flagged: false,
        }).catch(() => {});
      }
      throw new Error(_gov.reason);
    }
  }

  const apiKey = profile.apiKey;
  if (!apiKey) {
    if (_flags.ENABLE_DECISION_LOGGING) {
      logTrace({
        source_post_id: makeSourcePostId(context),
        decision_path:  "ai:no_api_key",
        model_version:  MODEL,
        outcome:        "no_api_key",
        latency_ms:     Date.now() - _t0,
        injection_flagged: false,
      }).catch(() => {});
    }
    throw new Error("Add your OpenAI API key in the extension options first.");
  }

  const broadCategory = detectBroadCategory(tweetText);
  const lengthCfg     = getLengthConfig(profile.length);
  const recentReplies = await getRecentReplies();
  const angle         = await pickAngle();

  // ── Phase 5: Intelligent Reply Engine (flag-gated) ─────────────────────
  // When ENABLE_INTELLIGENT_REPLY_ENGINE is true, runs the full Phase 3-5
  // pipeline: PostAnalyzer → embed → retrieve → rank → route → adapt/generate.
  // When false (default), execution falls through to the existing single-call
  // generator below — byte-for-byte identical to pre-Phase-3 behaviour.

  if (_flags.ENABLE_INTELLIGENT_REPLY_ENGINE) {
    return await _runIntelligentReplyEngine(
      context, profile, apiKey, recentReplies, lengthCfg, _flags, _t0
    );
  }

  // Prompt isolation — flag-gated. When ENABLE_PROMPT_ISOLATION is false,
  // buildUserMessage() is used unchanged (identical to pre-Phase-1).
  let _userMessage;
  let _injectionFlagged = false;
  let _systemExtra      = "";

  if (_flags.ENABLE_PROMPT_ISOLATION) {
    const _ctx       = buildPromptContext(context); // defined in prompt.js
    _userMessage     = _ctx.userBlock;
    _injectionFlagged = _ctx.injectionFlagged;
    _systemExtra     = _ctx.systemPreamble + "\n\n";
  } else {
    _userMessage = buildUserMessage(context);
  }

  const body = {
    model: MODEL,
    max_tokens: lengthCfg.max_tokens,
    messages: [
      { role: "system", content: _systemExtra + buildSystemPrompt(profile, broadCategory, recentReplies, angle, activeTemplates) },
      { role: "user",   content: _userMessage },
    ],
  };

  // Keep the service worker alive during the fetch
  const keepAlive = setInterval(
    () => chrome.storage.local.set({ _keepAlive: Date.now() }),
    5000
  );

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (fetchErr) {
    clearInterval(keepAlive);
    if (_flags.ENABLE_DECISION_LOGGING) {
      logTrace({
        source_post_id:    makeSourcePostId(context),
        decision_path:     "ai:gpt-4o-mini",
        model_version:     MODEL,
        outcome:           "error",
        latency_ms:        Date.now() - _t0,
        injection_flagged: _injectionFlagged,
        error_code:        "network_error",
      }).catch(() => {});
    }
    throw fetchErr;
  } finally {
    clearInterval(keepAlive);
  }

  if (!res.ok) {
    const errText = await res.text();
    if (_flags.ENABLE_DECISION_LOGGING) {
      logTrace({
        source_post_id:    makeSourcePostId(context),
        decision_path:     "ai:gpt-4o-mini",
        model_version:     MODEL,
        outcome:           "error",
        latency_ms:        Date.now() - _t0,
        injection_flagged: _injectionFlagged,
        error_code:        String(res.status),
      }).catch(() => {});
    }
    throw new Error(`API error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message || !choice.message.content) {
    throw new Error("No reply returned by the model.");
  }

  const reply = stripBannedOpener(choice.message.content.trim());

  // Record governor event after a successful call
  if (_flags.ENABLE_RATE_GOVERNOR) {
    recordGovernorEvent().catch(() => {}); // fire-and-forget
  }

  // Log success trace
  if (_flags.ENABLE_DECISION_LOGGING) {
    logTrace({
      source_post_id:    makeSourcePostId(context),
      decision_path:     "ai:gpt-4o-mini",
      model_version:     MODEL,
      outcome:           "success",
      latency_ms:        Date.now() - _t0,
      injection_flagged: _injectionFlagged,
    }).catch(() => {});
  }

  saveRecentReply(reply).catch(() => {}); // fire-and-forget, non-critical
  return reply;
}

// ── Phase 5: Intelligent Reply Engine orchestrator ────────────────────────────
//
// Runs the full Phases 3-5 pipeline:
//   PostAnalyzer → embed → retrieve → rank → route (ADAPT/INSPIRE/GENERATE)
//
// Called only when ENABLE_INTELLIGENT_REPLY_ENGINE flag is true.
// Any error here falls back to the classic single-call generator rather than
// crashing — the user always gets a reply.

async function _runIntelligentReplyEngine(context, profile, apiKey, recentReplies, lengthCfg, flags, t0) {
  const _apiConfig = {
    apiKey,
    model:  MODEL,
    apiUrl: API_URL,
  };

  let _analysis, _embedding, _candidates, _ranked, _routeResult;

  try {
    // ── 1. Analyse the source post ──────────────────────────────────────
    const analyzer = new PostAnalyzer();
    _analysis = await analyzer.analyze(context, _apiConfig.apiKey);

    // ── 2. Embed + retrieve ─────────────────────────────────────────────
    _embedding  = generateEmbedding(context.text || "");
    const db    = await openDatabase();
    const retriever = new ReplyRetriever({ maxCandidates: 30 });
    _candidates = await retriever.retrieve(_embedding, _analysis, db);

    // ── 3. Rank candidates ──────────────────────────────────────────────
    _ranked = rankCandidates(_candidates, _analysis, _candidates);

    // ── 4. Route ────────────────────────────────────────────────────────
    const recentTexts = recentReplies.slice(-20);
    _routeResult = routeCandidate(
      _ranked.length > 0 ? _ranked[0] : null,
      _analysis,
      recentTexts
    );
  } catch (pipelineErr) {
    console.warn("[ReplyGenie] Phase 3-4 pipeline error — falling back to classic generation:", pipelineErr);
    // Fall back to the classic single-call path
    return _runClassicGeneration(context, profile, apiKey, recentReplies, lengthCfg, flags, t0);
  }

  let _finalReply;
  let _decisionPath = "intelligent:" + (_routeResult.route || ROUTE.GENERATE);
  let _strategyId   = null;
  let _promptVersions = {};

  try {
    // ── 5a. ADAPT path ──────────────────────────────────────────────────
    if (_routeResult.route === ROUTE.ADAPT) {
      const adaptResult = await adaptReply(
        context,
        _routeResult.candidateUsed,
        _analysis,
        profile,
        _apiConfig,
        buildPromptContext,
        getLengthConfig
      );

      if (adaptResult.adapted && adaptResult.text) {
        _finalReply = adaptResult.text;
        _strategyId = _routeResult.candidateUsed.reply_strategy;
        _promptVersions.adapter = adaptResult.promptVersion;
      } else {
        // Adapter refused — fall to INSPIRE path
        console.info("[ReplyGenie] Adapter refused (", adaptResult.refusalReason, ") — falling to INSPIRE");
        _routeResult.route = ROUTE.INSPIRE;
        _decisionPath      = "intelligent:inspire:adapter_refused";
      }
    }

    // ── 5b. INSPIRE or (adapter fell to INSPIRE) ────────────────────────
    if (!_finalReply) {
      const strategyResult = await selectStrategy(
        context, _analysis, _ranked, _apiConfig, buildPromptContext
      );
      _strategyId = strategyResult.strategy_id;
      _promptVersions.stage1 = strategyResult.promptVersion;

      const inspirationCandidate = (_routeResult.route === ROUTE.INSPIRE)
        ? _routeResult.candidateUsed : null;

      const genResult = await generateCandidates(
        context,
        strategyResult,
        _analysis,
        _ranked,
        recentReplies,
        profile,
        _apiConfig,
        lengthCfg,
        buildPromptContext,
        inspirationCandidate
      );
      _promptVersions.stage2 = genResult.promptVersion;

      // ── Phase 6: Quality / Accuracy / Genericity Gate ────────────────
      const verifiedContext = {
        sourceText: context.text || "",
        candidateTexts: _ranked.map((c) => c.reply_text).filter(Boolean),
        voiceSamples: profile.voiceSamples || [],
      };

      const evalGateResult = await evaluateCandidates(
        genResult.candidates,
        context,
        profile,
        recentReplies,
        verifiedContext,
        _apiConfig,
        buildPromptContext,
        async function regenerateFn(failureReasons) {
          const retryStrategy = Object.assign({}, strategyResult, {
            angle: (strategyResult.angle || "") + " (Avoid prior failure modes: " + failureReasons.join(", ") + ")",
          });
          return await generateCandidates(
            context,
            retryStrategy,
            _analysis,
            _ranked,
            recentReplies,
            profile,
            _apiConfig,
            lengthCfg,
            buildPromptContext,
            inspirationCandidate
          );
        }
      );

      _finalReply = evalGateResult.text || null;
      if (evalGateResult.evalResult) {
        _promptVersions.evaluator = evalGateResult.evalResult.promptVersion || "evaluator-v1.0.0";
      }
      if (evalGateResult.queuedForReview) {
        _decisionPath += ":queued_for_human_review";
      } else if (evalGateResult.regenerated) {
        _decisionPath += ":regenerated_and_passed";
      }
    }
  } catch (genErr) {
    console.warn("[ReplyGenie] Intelligent generation error — falling back to classic:", genErr);
    return _runClassicGeneration(context, profile, apiKey, recentReplies, lengthCfg, flags, t0);
  }

  if (!_finalReply) {
    return _runClassicGeneration(context, profile, apiKey, recentReplies, lengthCfg, flags, t0);
  }

  const _reply = stripBannedOpener(_finalReply.trim());

  if (flags.ENABLE_RATE_GOVERNOR) recordGovernorEvent().catch(() => {});

  if (flags.ENABLE_DECISION_LOGGING) {
    logTrace({
      source_post_id:    makeSourcePostId(context),
      decision_path:     _decisionPath,
      model_version:     MODEL,
      outcome:           "success",
      latency_ms:        Date.now() - t0,
      injection_flagged: false,
      extra: {
        route:           _routeResult.route,
        strategy:        _strategyId,
        guards:          _routeResult.guardsTriggered,
        prompt_versions: _promptVersions,
      },
    }).catch(() => {});
  }

  saveRecentReply(_reply).catch(() => {});
  return {
    reply: _reply,
    meta: {
      decisionPath: _decisionPath,
      strategy: _strategyId,
      scores: (typeof evalGateResult !== "undefined" && evalGateResult && evalGateResult.evalResult) ? evalGateResult.evalResult.scores : null,
      compositeScore: (typeof evalGateResult !== "undefined" && evalGateResult && evalGateResult.evalResult) ? evalGateResult.evalResult.composite : null,
      promptVersions: _promptVersions,
      guardsTriggered: _routeResult ? _routeResult.guardsTriggered : [],
      requireHumanApproval: flags.REQUIRE_HUMAN_APPROVAL !== false,
      sourcePostId: makeSourcePostId(context),
    },
  };
}

// Thin wrapper to re-run classic single-call path when intelligent engine falls back.
async function _runClassicGeneration(context, profile, apiKey, recentReplies, lengthCfg, flags, t0) {
  const flags2 = Object.assign({}, flags, { ENABLE_INTELLIGENT_REPLY_ENGINE: false });
  return generateReply(context); // Re-enters generateReply which will skip Phase 5 block
}

// ---------- Post-processing ----------

const BANNED_OPENER_RE = /^(that'?s like|it'?s like|this is like|think of it|imagine if|kind of like|just like|right|yeah|yep|nope|true|fact|facts|same|agreed|correct|exactly|totally|absolutely|definitely|seriously|honestly|clearly|obviously|literally|great|nice|wow|cool|amazing|incredible|brilliant|perfect|wonderful|haha|lol|omg|indeed|interesting|ha|that'?s|what would you change|if starting fresh|if you were starting over|starting fresh today)[!?.,…\s]+/i;

function stripBannedOpener(text) {
  const stripped = text.replace(BANNED_OPENER_RE, "");
  if (stripped.length > 10) {
    return stripped.charAt(0).toUpperCase() + stripped.slice(1);
  }
  return text;
}
