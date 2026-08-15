# Contributing to ReplyGenie

Thank you for considering contributing to ReplyGenie! This document outlines the process for contributing and the conventions we follow.

---

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Pull Request Process](#pull-request-process)
- [Coding Conventions](#coding-conventions)
- [Testing Your Changes](#testing-your-changes)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold this code. Please report unacceptable behavior to the maintainers.

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/nishantnischal10467-cell/replygenie-extension.git
   cd replygenie-extension
   ```
3. **Create a branch** for your feature or fix:
   ```bash
   git checkout -b feat/my-new-feature
   # or
   git checkout -b fix/bug-description
   ```

---

## Development Setup

No build step is required — this is a vanilla Manifest V3 Chrome extension.

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** → select the project folder.
4. After making changes to JS/CSS/HTML files, click the **↺ refresh** icon on the extension card in `chrome://extensions`.

> **Tip:** For changes to `content.js` or `content.css`, you'll also need to refresh the x.com tab.

---

## Making Changes

### Branch naming

| Type | Pattern | Example |
|---|---|---|
| Feature | `feat/short-description` | `feat/firefox-port` |
| Bug fix | `fix/short-description` | `fix/selector-fallback` |
| Documentation | `docs/short-description` | `docs/update-readme` |
| Refactor | `refactor/short-description` | `refactor/extract-prompt-builder` |

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) format:
```
feat: add selector fallback layer for tweetText
fix: parse OpenAI JSON error body for human-readable messages
docs: add architecture diagram to README
```

---

## Pull Request Process

1. Make sure your branch is up to date with `main`:
   ```bash
   git fetch origin
   git rebase origin/main
   ```

2. **Run syntax checks** on all JS files you've modified:
   ```bash
   node --check background.js content.js popup.js options.js storage.js templates.js
   ```

3. **Validate `manifest.json`** is valid JSON:
   ```bash
   node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest.json OK')"
   ```

4. Push your branch and open a **Pull Request** against `main`.

5. Fill in the PR template:
   - What changed and why
   - Which files were modified
   - How you tested it

6. A maintainer will review and merge. Please be responsive to review feedback.

---

## Coding Conventions

- **Manifest V3 only** — no remote code execution, no `eval`, no `innerHTML` with untrusted data.
- **No build tools required** — keep the extension vanilla JS so it loads unpacked without a compile step.
- **No backend additions** — this is a bring-your-own-key extension; don't add server-side components without explicit discussion.
- **Storage schema compatibility** — if you change the `profile` object in `chrome.storage.sync`, write a forward migration so existing user data isn't corrupted.
- **Console logging** — use `console.warn` (not `console.error`) for non-critical selector fallbacks. Use `[ReplyGenie]` prefix for all log messages.
- **Error messages** — surface human-readable errors in the reply card (e.g., "Invalid API key", "Rate limited"). Don't expose raw API responses to the user.
- **Code style:**
  - 2-space indentation
  - Single quotes for JS strings
  - Semicolons required
  - `const` by default; `let` when reassignment is needed

---

## Testing Your Changes

Since there are no automated test runners yet:

1. Load the extension unpacked in Chrome.
2. Navigate to [x.com](https://x.com).
3. Verify the ✨ Reply button appears on tweets in your feed.
4. Click the button and confirm the reply card loads correctly.
5. Test error states by temporarily using an invalid API key and confirm the error message is readable.
6. Test the Options page — fill in all fields, save, and re-open to confirm persistence.

### Key scenarios to cover

- ✅ Normal reply generation
- ✅ Template short-circuit (try: a tweet saying "Congrats!" or "Thanks for connecting")
- ✅ Error state (bad API key)
- ✅ Auto-copy toggle on/off
- ✅ Tone and length selection
- ✅ Voice sample clearing from Options

---

## Questions?

Open a [GitHub Discussion](../../discussions) or file an [Issue](../../issues). We're happy to help!
