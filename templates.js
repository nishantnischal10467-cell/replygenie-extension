// templates.js — Reply template library
// Loaded by background.js via importScripts()
// Use {name} as a placeholder for the post author's first name.

/* eslint-disable no-var */

var TEMPLATES = {

  // ── Connect request replies ───────────────────────────────────────────────
  connect: [
    "hey {name}, can we connect?",
    "would love to connect too {name} if that's ok?",
    "hey {name}, can we connect as well?",
    "hey {name}, would it be okay if we connect?",
    "{name}, can we connect too so we can help each other grow?",
    "would you mind if we connect as well?",
    "connect?",
    "I build in public! can we connect {name}?",
    "I'm an indie hacker — would love to connect if that's ok {name}?",
    "can we connect as well?",
    "down to connect {name}?",
    "always down to connect with fellow builders {name}",
    "connect {name}?",
    "connecting now {name}, let's grow together",
    "hey {name}, happy to connect!",
    "let's connect and help each other grow {name}",
  ],

  // ── Thank you replies ─────────────────────────────────────────────────────
  thanks: [
    "thanks so much {name} 🙏🏻",
    "appreciate you :D",
    "thank you {name} 🔥",
    "this means a lot, thank you 🙏🏻",
    "you're the best {name} 👊🏻",
    "thanks a ton :D",
    "really appreciate this {name} 🔥",
    "so glad you liked it, thanks 🙏🏻",
    "you made my day {name} 👊🏻",
    "thank you, appreciate you 🔥",
    "means a lot {name} 🙏🏻",
    "genuinely appreciate it, thank you",
  ],

  // ── Congratulations replies ───────────────────────────────────────────────
  congratulations: [
    "congrats {name}! that's a huge milestone.",
    "that's a huge milestone.",
    "keep growing {name}!",
    "well deserved {name} 🔥",
    "this is just the beginning {name}",
    "huge congrats — what's next?",
    "love to see it {name} 👊🏻",
    "congrats! how long did it take to get here?",
    "incredible {name} — keep shipping!",
    "that's the kind of win worth celebrating 🎉",
  ],

  // ── Contrarian replies (AI tone guidance) ────────────────────────────────
  contrarian: [
    "disagree — most people say that until they try the opposite.",
    "counterpoint: the data actually suggests the reverse is true more often.",
    "hot take but I've found the exact opposite works better in practice.",
    "worth stress-testing that assumption though.",
    "I'd push back on this — context matters a lot here.",
    "unpopular opinion but this only works if you already have distribution.",
  ],

  // ── Funny / witty replies ─────────────────────────────────────────────────
  funny: [
    "my wallet would like a word.",
    "tell me you've never shipped without telling me.",
    "bold strategy, let's see how it plays out.",
    "sounds right until 3am when the bugs start.",
    "production says otherwise.",
    "the server at 2am: 'hold my uptime'.",
    "my imposter syndrome is taking notes.",
  ],

  // ── Insightful replies ────────────────────────────────────────────────────
  insightful: [
    "the compounding effect here is what most people miss.",
    "this is the unsexy truth nobody talks about.",
    "pattern I've noticed: the people who do this consistently outperform by year 3.",
    "what makes this work is the second-order effect — most stop at the first.",
    "the problem isn't knowing this, it's doing it on the days you don't feel like it.",
    "most people optimise for the wrong variable here.",
  ],

  // ── Builder / startup replies ─────────────────────────────────────────────
  builder: [
    "how's the retention looking after 30 days?",
    "what channel is driving the most of your growth right now?",
    "MRR is great — what's the churn looking like?",
    "shipped mine last month, the hardest part was deciding what to cut.",
    "the gap between 'working' and 'people pay for it' is the real game.",
    "what does your onboarding look like right now?",
    "distribution before product is underrated.",
  ],

  // ── AI / tech replies ─────────────────────────────────────────────────────
  ai: [
    "the real moat isn't the model, it's the data and the workflow around it.",
    "fine-tuning vs RAG debate is still going and honestly both are right depending on use case.",
    "what's the latency like at scale?",
    "the UX layer on top of LLMs is where the actual differentiation happens.",
    "this is exactly where most AI wrappers fall apart — curious what your approach is.",
    "prompt engineering still matters more than most people want to admit.",
  ],

  // ── Marketing replies ─────────────────────────────────────────────────────
  marketing: [
    "what's your current CAC looking like?",
    "organic > paid until you have real PMF — this is the play.",
    "the hook is everything. first 3 seconds or you've lost them.",
    "most people skip the positioning step and wonder why nothing converts.",
    "what's your email open rate on this sequence?",
    "community-led growth is so underrated at the early stage.",
  ],

  // ── Personal branding replies ─────────────────────────────────────────────
  branding: [
    "consistency over virality every time.",
    "the niche-down fear is real but the generalist trap is worse.",
    "your distribution is the moat, not the content itself.",
    "people follow people, not logos — this is the thing most brands miss.",
    "posting consistently for 6 months is 10x harder than it sounds.",
    "the best personal brands are just honest documentation of the work.",
  ],

  // ── Engagement / discussion replies ──────────────────────────────────────
  engagement: [
    "what's the one thing you wish you'd known before starting this?",
    "how long did it take before it started clicking?",
    "genuinely curious — what made you decide to go this route?",
    "what would you do differently if you were starting over?",
    "the timing of this is interesting — what pushed you to share this now?",
    "drop the link, I want to dig into this more.",
  ],

};

// ── Intent detection ─────────────────────────────────────────────────────────
// Returns a category key or null if no template category matches.

var INTENT_PATTERNS = [
  {
    category: "connect",
    // Post is explicitly about connecting / following each other
    test: (t) =>
      (/\bconnect\b/.test(t) && /\b(let'?s|can we|want to|would love to|shall we)\b/.test(t)) ||
      /\bfollow (each other|back|you back)\b/.test(t) ||
      /\bgrowing together\b/.test(t),
  },
  {
    category: "thanks",
    // Post is a thank-you / appreciation message directed at followers/community
    test: (t) =>
      /\bthank (you|u)\b/.test(t) ||
      /\bthanks? (so much|a lot|everyone|for the)\b/.test(t) ||
      /\bgrateful\b/.test(t) ||
      /\bappreciat/.test(t),
  },
  {
    category: "congratulations",
    // Post celebrates a milestone, achievement, or announcement
    test: (t) =>
      /\bcongrat(s|ulation)/.test(t) ||
      /\bmilestone\b/.test(t) ||
      /\b(just hit|just reached|finally hit|crossed)\b/.test(t) ||
      /\bwe('?re| are) (live|launched|shipping)\b/.test(t),
  },
];

// ── Broad category detection (for AI tone guidance) ──────────────────────────

var BROAD_CATEGORY_PATTERNS = [
  { category: "ai",        test: (t) => /\b(ai|llm|gpt|chatgpt|artificial intelligence|machine learning|neural|prompt)\b/.test(t) },
  { category: "builder",   test: (t) => /\b(startup|saas|mrr|arr|indie hacker|building|shipped|launched|revenue|users|pmf)\b/.test(t) },
  { category: "marketing", test: (t) => /\b(marketing|seo|growth|funnel|conversion|audience|cac|email list|newsletter)\b/.test(t) },
  { category: "branding",  test: (t) => /\b(personal brand|content creator|following|followers|niche|consistency|posting)\b/.test(t) },
  { category: "contrarian",test: (t) => /\b(unpopular opinion|hot take|controversial|disagree|actually|everyone says)\b/.test(t) },
];
