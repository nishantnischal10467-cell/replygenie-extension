# ReplyGenie — AI Replies for X/Twitter

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest Version](https://img.shields.io/badge/Manifest-V3-green.svg)](manifest.json)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-yellow.svg?logo=google-chrome)](https://developer.chrome.com/docs/extensions/)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnishantnischal10467-cell%2Freplygenie-extension)

> A Chrome extension that reads the post you're viewing on X/Twitter (text, images, video), drafts a contextual reply in your voice using GPT-4o-mini, and copies it to your clipboard so you just paste and post.

---

## ✨ Features

- **AI-powered replies** — GPT-4o-mini reads each tweet and writes a reply that matches the context, not a generic template
- **Voice learning** — Quietly captures your own replies over time and steers future generations to match your real writing style
- **25 reply angles** — Rotates through distinct structural approaches (questions, takes, data points, reframes) so replies never feel repetitive
- **Auto-copy to clipboard** — Generated reply lands in your clipboard instantly; just click X's reply box and paste
- **Template short-circuit** — For common interactions (connecting, thanking, congrats) it fires a hand-crafted template instantly — no API call, no cost
- **Bring-your-own key** — Your OpenAI API key is stored locally in your browser only, never sent to any third-party server
- **Debounced & rate-limited** — Cooldown guard prevents accidental duplicate API calls on the same tweet
- **Manifest V3** — Built to Chrome's latest extension standard; no remote code, no `eval`

---

## 🚀 Quick Start (Developer Install)

1. **Clone or download** this repository somewhere permanent (Chrome loads the extension from these files directly — don't move/delete the folder after installing).
   ```bash
   git clone https://github.com/nishantnischal10467-cell/replygenie-extension.git
   ```

2. Open `chrome://extensions` in Chrome.

3. Enable **Developer mode** (top-right toggle).

4. Click **Load unpacked** and select the cloned folder.

5. Pin the ReplyGenie icon in your toolbar for easy access.

---

## ⚙️ Configuration

1. Click the extension icon → **Options** (or **Update my replies**).
2. Paste your **OpenAI API key** — get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). The key is stored only in your browser's local extension storage and is never sent anywhere except directly to OpenAI's API.
3. Fill in your handle, "about you", intentions, interests, topics to mention/avoid, tone, and preferred length.
4. **Save**.

---

## 🎯 Using It

1. Go to [x.com](https://x.com) and scroll your feed or open a post.
2. Each post has a small ✨ **Reply** button in its action bar.
3. Click it — the extension reads the post's text + images, picks a fresh reply angle, and drafts a reply.
4. With **Auto copy** on (default), the reply hits your clipboard immediately — click X's native reply box and paste.

### Voice Learning
Whenever you send a reply manually on X, the extension quietly captures that text as a writing sample (stored locally, last 15 samples). Future generated replies are steered to match that voice. Clear this at any time from **Options**.

---

## 🏗️ Architecture

```
replygenie-extension/
├── manifest.json          # MV3 extension manifest
├── background.js          # Service worker — owns all OpenAI API calls
├── content.js             # Injected into x.com — injects buttons, shows reply card
├── content.css            # Styles for the injected reply card
├── templates.js           # Hand-crafted reply templates + intent/category patterns
├── popup.html/js/css      # Quick-access toggle panel
├── options.html/js/css    # Full profile form
├── storage.js             # Storage utility helpers
└── icons/                 # Extension icons (16, 48, 128px)
```

**Data flow:**
```
User clicks ✨ Reply
  → content.js extracts tweet context (text, handle, images)
  → Opens a long-lived port to background.js
  → background.js checks for template short-circuit
  → If AI needed: reads profile from chrome.storage.sync, picks angle, calls OpenAI
  → Streams reply back to content.js
  → Content.js shows card + auto-copies to clipboard
```

---

## 🌐 Vercel Deployment

The project includes `vercel.json` and a root `index.html` (Landing Page) optimized for Vercel deployment:

1. Click the **Deploy with Vercel** button above or connect your GitHub repository in the [Vercel Dashboard](https://vercel.com/new).
2. Vercel will automatically detect `index.html` / `vercel.json` and deploy the landing page cleanly.

---

## 📝 Notes & Limitations

- **No backend** — this calls the OpenAI API directly using your own key, billed to your own OpenAI account.
- **Video content** — sends the video's poster thumbnail as context; does not download or watch the full video.
- **X's DOM drifts** — if the ✨ button stops appearing, X likely changed their markup. The selectors in `content.js` (`data-testid="tweet"`, `tweetText`, etc.) will need a small update.
- **"Jump to posts worth opening"** toggle is persisted to storage but not yet wired to behavior — see `CLAUDE_CODE_PROMPT.md` for extending it.
- API calls happen from the background service worker; your API key never touches x.com's page context.

---

## 🛠️ Extending This

See [`CLAUDE_CODE_PROMPT.md`](CLAUDE_CODE_PROMPT.md) for a ready-to-paste prompt you can hand to an AI coding assistant to continue building this out:

- Packaging as a `.crx` / Chrome Web Store submission
- "Jump to posts worth opening" heuristic feature
- Better X DOM selector resilience
- Firefox (MV3) port
- Jest unit tests for `buildSystemPrompt` / `buildUserContent`

---

## 🤝 Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

---

## 🔒 Security

If you discover a security vulnerability (especially around API key handling), please follow the responsible disclosure process in [`SECURITY.md`](SECURITY.md).

---

## 📄 License

[MIT](LICENSE) — free to use, modify, and distribute.
