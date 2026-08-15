# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | ✅ Yes             |

---

## Reporting a Vulnerability

ReplyGenie handles **OpenAI API keys** stored in `chrome.storage.sync`. Security of that data is critical. If you discover a security vulnerability — especially related to:

- API key exposure or leakage
- Content script privilege escalation
- Cross-origin data leakage
- Insecure storage of user data

**Please do NOT open a public GitHub Issue.**

### How to report

1. Open a **private** GitHub Security Advisory: go to the repository → **Security** tab → **Report a vulnerability**.
2. Alternatively, contact the maintainer directly via the email listed in their GitHub profile.

### What to include

- A clear description of the vulnerability
- Steps to reproduce or a proof-of-concept
- The potential impact (what an attacker could achieve)
- Your suggested fix if you have one

### What to expect

- An acknowledgment within **72 hours**
- A status update within **7 days**
- A patch release as quickly as possible (target: within 14 days for critical issues)
- Credit in the release notes (unless you prefer to remain anonymous)

---

## Security Design Notes

For contributors and auditors, here is the security model of this extension:

| Concern | How it's handled |
|---|---|
| API key storage | Stored in `chrome.storage.sync` (encrypted by Chrome, tied to user's Google account). Never written to `localStorage`, cookies, or the page DOM. |
| API calls | Made exclusively from the **background service worker** (`background.js`), never from the content script. The content script never has access to the raw key. |
| Content injection | `content.js` injects UI elements but never reads or writes any data to x.com's own storage or DOM outside of scoped `article[data-testid="tweet"]` elements. |
| No remote code | The extension contains no remote script loading, no `eval`, and no dynamic code execution. All code ships in the extension package itself. |
| `innerHTML` | Used only with `escapeHtml()`-sanitized content in the reply card. User-generated and API-generated content is always escaped before insertion. |

---

## Out of Scope

The following are **not** considered security vulnerabilities for this project:

- X/Twitter's own security practices
- OpenAI's API security
- Issues with the user's Chrome profile or OS security
- Self-XSS (the user deliberately injecting script into their own extension)
