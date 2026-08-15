// background.js — MV3 service worker

// Load the reply template library (sets global TEMPLATES, INTENT_PATTERNS, BROAD_CATEGORY_PATTERNS)
importScripts("templates.js");

const API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL   = "gpt-4o-mini";

// ---------- Long-lived port listener (MV3-safe for async work) ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "reply-genie") return;

  port.onMessage.addListener(async (message) => {
    if (message.type === "GENERATE_REPLY") {
      try {
        const reply = await generateReply(message.context);
        port.postMessage({ reply });
      } catch (err) {
        console.error("[ReplyGenie] generateReply failed:", err);
        port.postMessage({ error: err.message || String(err) });
      }
    }
    if (message.type === "LEARN_FROM_REPLY") {
      try {
        await learnFromReply(message.replyText);
        port.postMessage({ ok: true });
      } catch (err) {
        port.postMessage({ error: err.message || String(err) });
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
  { id: 1, text: "Ask what the person would do differently if they started this today with what they know now." },
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

/**
 * Extracts the first name from the author's display name or handle.
 * "John Doe" → "John", "@johndoe" → "Johndoe", "" → "there"
 */
function extractFirstName(context) {
  const source = context.displayName || context.handle || "";
  const cleaned = source.replace(/^@/, "").split(/[\s_]/)[0].replace(/[^a-zA-Z]/g, "");
  if (!cleaned) return "there";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/**
 * Picks a random item from an array.
 */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Fills {name} placeholder in a template string.
 */
function fillTemplate(template, firstName) {
  return template.replace(/\{name\}/g, firstName);
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

/**
 * Returns the prompt instruction and max_tokens ceiling for a given length setting.
 * max_tokens acts as a hard backstop — the model cannot produce more tokens than this
 * even if it ignores the word-count instruction.
 */
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

function buildSystemPrompt(profile, broadCategory, recentReplies, angle) {
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
    "== BANNED OPENERS — NEVER start a reply with any of these ==",
    "Single-word reactions: Right, Yeah, Yep, Nope, True, Fact, Facts, Same, Agreed, Correct, Exactly, Totally, Absolutely, Definitely, Seriously, Honestly, Clearly, Obviously, Literally",
    "Hollow affirmations: Great, Nice, Wow, Cool, Amazing, Incredible, Brilliant, Perfect, Wonderful, Love this, This is so true, So true, Well said, Such a great point, I completely agree",
    "Filler openers: Right?, Ha!, Haha, Lol, OMG, Oh wow, Oh man, Oh no, Indeed, Interesting, That's, It's like, This is like",
    "Life-coach phrases: Congrats on, So proud, This is inspiring, Keep going, You got this",
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
  if (broadCategory && TEMPLATES[broadCategory]) {
    lines.push("");
    lines.push(`== TOPIC CATEGORY: ${broadCategory.toUpperCase()} — example replies in this style ==`);
    const examples = TEMPLATES[broadCategory].slice(0, 4);
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
  const firstName = extractFirstName(context);
  const tweetText = context.text || "";

  // ── 1. Template short-circuit ──────────────────────────────────────────
  // For common intents (connect / thanks / congrats), pick a template directly.
  // No API call needed — instant response.
  const templateCategory = detectTemplateIntent(tweetText);
  if (templateCategory && TEMPLATES[templateCategory]) {
    const template = pickRandom(TEMPLATES[templateCategory]);
    return fillTemplate(template, firstName);
  }

  // ── 2. AI generation ────────────────────────────────────────────────────
  const profile = await getProfile();
  const apiKey = profile.apiKey;

  if (!apiKey) throw new Error("Add your OpenAI API key in the extension options first.");

  const broadCategory = detectBroadCategory(tweetText);
  const lengthCfg     = getLengthConfig(profile.length);
  const recentReplies = await getRecentReplies();
  const angle         = await pickAngle(); // async — reads + writes used angle ids

  const body = {
    model: MODEL,
    max_tokens: lengthCfg.max_tokens,
    messages: [
      { role: "system", content: buildSystemPrompt(profile, broadCategory, recentReplies, angle) },
      { role: "user",   content: buildUserMessage(context) },
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
  } finally {
    clearInterval(keepAlive);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message || !choice.message.content) {
    throw new Error("No reply returned by the model.");
  }

  const reply = stripBannedOpener(choice.message.content.trim());

  // Save to history so next request can avoid the same patterns
  saveRecentReply(reply).catch(() => {}); // fire-and-forget, non-critical

  return reply;
}

// ---------- Post-processing ----------

// Catches patterns that slip through the system prompt, including the notorious
// 'That's like...', 'It's like...', simile openers, and all known filler words.
const BANNED_OPENER_RE = /^(that'?s like|it'?s like|this is like|think of it|imagine if|kind of like|just like|right|yeah|yep|nope|true|fact|facts|same|agreed|correct|exactly|totally|absolutely|definitely|seriously|honestly|clearly|obviously|literally|great|nice|wow|cool|amazing|incredible|brilliant|perfect|wonderful|haha|lol|omg|indeed|interesting|ha|that'?s)[!?.,…\s]+/i;

function stripBannedOpener(text) {
  const stripped = text.replace(BANNED_OPENER_RE, "");
  if (stripped.length > 10) {
    return stripped.charAt(0).toUpperCase() + stripped.slice(1);
  }
  return text;
}
