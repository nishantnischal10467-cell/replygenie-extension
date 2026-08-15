# Prompt for Claude Code

Paste everything below into Claude Code inside this project folder.

---

You're continuing work on **ReplyGenie**, a Manifest V3 Chrome extension that
drafts AI replies to X/Twitter posts. The MVP already exists in this folder —
read `manifest.json`, `content.js`, `background.js`, `popup.*`, and
`options.*` first to understand the current architecture before changing
anything.

## Current architecture (don't restructure without reason)
- `content.js` — injects a "Reply" button into every tweet's action bar,
  scrapes tweet text/images/video via DOM selectors scoped to
  `article[data-testid="tweet"]`, and shows a floating suggestion card.
- `background.js` — MV3 service worker; owns all calls to the OpenAI
  Chat Completions API (`https://api.openai.com/v1/chat/completions`,
  model `gpt-4o-mini`) using the user's own API key from
  `chrome.storage.sync`, builds the system prompt from the saved profile,
  and returns the drafted reply to the content script.
- `popup.html/js/css` — quick-access toggle panel (auto-copy, tone, link to
  full options page).
- `options.html/js/css` — the full profile form (handle, about you,
  intentions, interests, mention/never-mention, tone, length, learned voice
  samples).
- Voice learning: `content.js` listens for clicks on X's own native
  "tweetButton"/"tweetButtonInline" and sends the text the user just posted
  to `background.js` as a `LEARN_FROM_REPLY` message, which appends it (max
  15 samples) to `profile.voiceSamples` for future prompt-building.

## Fix / harden first
1. **Selector resilience**: X's DOM/testids drift over time. Add a small
   selector-fallback layer (try a primary selector, then 1-2 alternates)
   for: tweet container, tweet text, author handle, image nodes, video
   node, and the native reply-compose textbox. Log (console.warn, not
   user-facing) when a fallback is used so it's easy to spot breakage.
2. **Error states**: `background.js` currently throws a bare Error on
   non-2xx API responses. Parse OpenAI's JSON error body and surface a
   short, human-readable reason in the card (e.g. "Invalid API key",
   "Rate limited — try again in a bit").
3. **Rate limiting / spam guard**: debounce the Reply button so a user can't
   fire five requests on the same tweet in two seconds.

## Feature: "Jump to posts worth opening"
The toggle exists in the popup and is persisted to storage, but does nothing
yet. Implement it: when enabled, the content script should scan tweets in
the viewport and lightly flag ones that look reply-worthy (e.g. from
accounts the user interacts with, has decent engagement, or matches the
user's stated `interests`) with a subtle visual marker — no extra API calls
per tweet; keep this heuristic and client-side only, don't burn API credits
scanning every tweet in the feed.

## Feature: insert reply directly into the compose box (optional upgrade)
Currently the reply is copied to the clipboard and the user pastes it
manually. Add an option (default off, since some users may prefer manual
paste) to auto-fill X's native reply textarea directly via
`document.execCommand("insertText", ...)` or by dispatching the correct
input events React expects — X's compose box is a contenteditable div
backed by React state, so plain `.value =` assignment won't work; you need
to dispatch native `InputEvent`s or use the `execCommand` approach so
React's onChange fires.

## Nice-to-haves, pick based on judgment
- Firefox (MV3 via `browser_specific_settings`) port.
- A lightweight local cache (per tweet URL) so re-opening the same card
  within a session doesn't re-call the API.
- Model choice in Options (fall back sensibly if unset).
- Basic Jest tests for `buildSystemPrompt` / `buildUserContent` in
  `background.js` (these are pure functions and easy to test in isolation —
  extract them to a testable module if needed).

## Constraints
- Keep it Manifest V3, no remote code execution, no eval.
- Don't add a backend/server unless I explicitly ask — this stays a
  bring-your-own-API-key extension for now.
- Don't break the existing storage schema (`profile` object in
  `chrome.storage.sync`) without writing a migration.

Work incrementally, run `node --check` on any JS you touch, and tell me
which files changed and why after each meaningful step.
