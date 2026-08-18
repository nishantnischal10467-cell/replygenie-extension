# CLAUDE.md — ReplyGenie Project Guide

## Project Overview
ReplyGenie is a Manifest V3 Chrome extension that generates AI-powered replies for X (Twitter) posts.

## Essential Commands & Verification
- **JS Syntax Check**: `node --check background.js content.js popup.js options.js storage.js templates.js`
- **Re-install Modern Web Guidance Skills**: `npx modern-web-guidance@latest install --choose`
- **Re-sync Vercel Design System**: `npx getdesign@latest add vercel`

---

## 🎨 Mandatory Design System & Skills

Before taking action or writing UI code (`popup.*`, `options.*`, `Landingpage.html`, or `content.css`), consult these reference files:

1. **[DESIGN.md](file:///c:/Users/getgo/Downloads/replygenie-extension/DESIGN.md)**: Installed via `getdesign` (Vercel-inspired design language).
   - Use high-contrast ink (`#171717`), crisp canvas backgrounds (`#ffffff`/`#fafafa`), hairline borders (`#ebebeb`), and Geist/Inter typography.
   - Maintain a polished, developer-grade aesthetic. Avoid default browser styles or generic low-contrast visuals.

2. **Web Design Guidelines Skill**: [.agents/skills/web-design-guidelines/SKILL.md](file:///c:/Users/getgo/Downloads/replygenie-extension/.agents/skills/web-design-guidelines/SKILL.md)
   - Follow web interface standards, accessibility guidelines, and responsive layout rules.

3. **Tailwind CSS v4 Skill**: [.agents/skills/tailwind-4-docs/SKILL.md](file:///c:/Users/getgo/Downloads/replygenie-extension/.agents/skills/tailwind-4-docs/SKILL.md)
   - Refer to Tailwind v4 documentation snapshots for styling utilities and migration gotchas.

---

## 🧩 Chrome Extension MV3 Standards

Before modifying extension files (`manifest.json`, `background.js`, `content.js`), consult:

1. **Chrome Extensions Skill**: [.agents/skills/chrome-extensions/SKILL.md](file:///c:/Users/getgo/Downloads/replygenie-extension/.agents/skills/chrome-extensions/SKILL.md)
   - Follow Manifest V3 constraints: no `eval()`, no remote code, non-persistent service worker in `background.js`.
   - DOM selector resilience: use fallback selectors for X/Twitter DOM elements in `content.js`.
   - Icons: ensure all icons declared in `manifest.json` exist as valid PNG files.

---

## 🏛️ Code Architecture
- `manifest.json` — Extension manifest (MV3).
- `background.js` — Service worker owning OpenAI API integration (`gpt-4o-mini`), storage management, and prompt construction.
- `content.js` / `content.css` — Scrapes tweets on X (`article[data-testid="tweet"]`), injects "Reply" button, displays floated AI reply card, captures posted replies for voice learning.
- `popup.html` / `.js` / `.css` — Extension popup UI for quick setting toggles.
- `options.html` / `.js` / `.css` — User profile options (API Key, tone, interests, custom instructions).
- `skills-lock.json` — Lockfile tracking installed agent skills.
