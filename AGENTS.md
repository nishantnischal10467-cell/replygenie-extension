# Agent Instructions — ReplyGenie Extension

This document provides mandatory guidelines, design standards, architecture rules, and reference skills for AI Coding Agents working on the **ReplyGenie** repository.

---

## 🎨 Design System & UI Guidelines (MANDATORY BEFORE ANY UI WORK)

Before creating, editing, or styling any UI component (including `popup.html`, `options.html`, `Landingpage.html`, or injected `content.css` elements):

1. **Read [DESIGN.md](file:///c:/Users/getgo/Downloads/replygenie-extension/DESIGN.md)**: Installed via `getdesign` (Vercel-inspired design system).
   - **Palette**: Monochromatic ink (`#171717`), stark white canvas (`#ffffff`), soft canvas background (`#fafafa`), hairline borders (`#ebebeb`), link accents (`#0070f3`), and gradient accents (`cyan`, `magenta`, `amber`).
   - **Typography**: `Geist`, `Inter`, or system sans-serif for display headings; monospaced for labels/technical badges.
   - **Aesthetics**: Clean, high-contrast, premium developer-tool aesthetic with subtle borders and smooth micro-interactions. Avoid plain/generic default styling.

2. **Web Design Guidelines Skill**: Consult [.agents/skills/web-design-guidelines/SKILL.md](file:///c:/Users/getgo/Downloads/replygenie-extension/.agents/skills/web-design-guidelines/SKILL.md) for web interface guidelines, accessibility compliance, and UI quality review.

3. **Tailwind CSS v4 Skill**: Consult [.agents/skills/tailwind-4-docs/SKILL.md](file:///c:/Users/getgo/Downloads/replygenie-extension/.agents/skills/tailwind-4-docs/SKILL.md) for Tailwind v4 utility references, configuration, and gotcha checks.

---

## 🧩 Chrome Extensions Skill & MV3 Standards

When writing extension logic (manifest, content scripts, service workers, popup/options UI):

1. **Read [.agents/skills/chrome-extensions/SKILL.md](file:///c:/Users/getgo/Downloads/replygenie-extension/.agents/skills/chrome-extensions/SKILL.md)**: Official Manifest V3 best practices from `GoogleChrome/modern-web-guidance`.
2. **Strict Manifest V3 Rules**:
   - No remote code execution or `eval()`.
   - Keep service worker (`background.js`) stateless and non-persistent.
   - Never reference non-existent icon files in `manifest.json`.
   - Validate Chrome permissions and content script match patterns.

---

## 🏗️ Architecture & Project Overview

**ReplyGenie** is a Manifest V3 Chrome extension that drafts AI replies for X (Twitter) posts using OpenAI's API.

### File Structure & Responsibilities
- **[manifest.json](file:///c:/Users/getgo/Downloads/replygenie-extension/manifest.json)**: Manifest V3 declaration, permissions (`storage`), host permissions, background worker, and content script registration.
- **[background.js](file:///c:/Users/getgo/Downloads/replygenie-extension/background.js)**: Service worker handling OpenAI API calls (`gpt-4o-mini`), prompt building from user profile, error handling, and voice sample storage.
- **[content.js](file:///c:/Users/getgo/Downloads/replygenie-extension/content.js)** & **[content.css](file:///c:/Users/getgo/Downloads/replygenie-extension/content.css)**: Injects the "Reply" button into tweet action bars, scrapes tweet context from `article[data-testid="tweet"]`, displays suggestion cards, and listens for native post submissions to learn voice samples.
- **[popup.html](file:///c:/Users/getgo/Downloads/replygenie-extension/popup.html)** / **[popup.js](file:///c:/Users/getgo/Downloads/replygenie-extension/popup.js)** / **[popup.css](file:///c:/Users/getgo/Downloads/replygenie-extension/popup.css)**: Extension popup for quick settings toggles (auto-copy, tone, link to options).
- **[options.html](file:///c:/Users/getgo/Downloads/replygenie-extension/options.html)** / **[options.js](file:///c:/Users/getgo/Downloads/replygenie-extension/options.js)** / **[options.css](file:///c:/Users/getgo/Downloads/replygenie-extension/options.css)**: User profile setup (API key, persona, voice samples, interests, instructions).
- **[Landingpage.html](file:///c:/Users/getgo/Downloads/replygenie-extension/Landingpage.html)**: Project showcase / landing page.
- **[skills-lock.json](file:///c:/Users/getgo/Downloads/replygenie-extension/skills-lock.json)**: Managed agent skills registry.

---

## ⚡ Agent Workflow & Code Integrity

1. **Before modifying UI**: Always check [DESIGN.md](file:///c:/Users/getgo/Downloads/replygenie-extension/DESIGN.md) and [.agents/skills/web-design-guidelines/SKILL.md](file:///c:/Users/getgo/Downloads/replygenie-extension/.agents/skills/web-design-guidelines/SKILL.md).
2. **Before modifying extension logic**: Always check [.agents/skills/chrome-extensions/SKILL.md](file:///c:/Users/getgo/Downloads/replygenie-extension/.agents/skills/chrome-extensions/SKILL.md).
3. **Syntax Validation**: Validate JS syntax before concluding any task:
   ```bash
   node --check background.js content.js popup.js options.js
   ```
