# PHASE 7 — Human Review Checkpoint
## ReplyGenie Chrome Extension

**Completed:** 2026-08-28  
**Tests:** 14 suites passing (all green)  
**Syntax check:** All files pass `node --check`  
**Flag:** `REQUIRE_HUMAN_APPROVAL` — **default `true`**

---

## 1. Architecture & Flow Overview

Phase 7 introduces an explicit, lightweight manual gate in the existing UI before any draft reply is inserted, copied, or posted to X/Twitter.

```
Intelligent Reply Pipeline (Phases 3–6)
       │
       ▼
Best Candidate + Scores + Decision Trace (Metadata)
       │
       ▼
REQUIRE_HUMAN_APPROVAL Check (default: true)
       │
       ├─► TRUE: Surface in Injected Card (Human Review Checkpoint)
       │     ├─ Metadata Bar: Strategy Badge + Quality Score Pill
       │     ├─ Quick-Edit: Interactive editable textarea
       │     └─ One-Click Actions:
       │          ├─ [Approve]: Confirms quick-edited text, copies/inserts, marks approved
       │          ├─ [Regen]: Triggers immediate regeneration
       │          └─ [Reject]: Expands rejection panel with taxonomy tags:
       │               ├─ GENERIC, UNSUPPORTED_CLAIM, FORCED_QUESTION,
       │               │  REPETITIVE, TOO_AGREEABLE, OFF_TOPIC,
       │               │  LOW_RELEVANCE, OBVIOUS_AI
       │               └─ Records rejection to `chrome.storage.local.manualRejections`
       │                  (Used as negative training signal in Phase 9)
       │
       └─► FALSE (Automated Mode):
             └─ Directly copies or inserts reply based on user autoCopy profile
```

---

## 2. Feature Flag

### `REQUIRE_HUMAN_APPROVAL`
- **Location:** `src/background/flags.js`
- **Default Value:** `true` (Active by default per specification)
- **Override Mechanism:** Configurable via `chrome.storage.sync` under `featureFlags.REQUIRE_HUMAN_APPROVAL`.

---

## 3. UI Implementation & Design Compliance

In accordance with the project's **Vercel Design System** ([`DESIGN.md`](file:///c:/Users/getgo/Downloads/replygenie-extension/DESIGN.md)):
- **Monochromatic Ink Foundation**: Card `#0a0a0c`, textarea `#050505`, subtle hairline borders `rgba(255, 255, 255, 0.1)`.
- **Strategy & Score Badges**: JetBrains Mono monospace font, subtle color-coded pills (`#0070f3` for Strategy, `#50e3c2` for Quality score).
- **Taxonomy Tag Buttons**: Compact interactive tags (`.rg-tag-btn`) with smooth hover transitions and clear visual feedback upon submission (`Feedback recorded (TAG) ✓`).
- **One-Click Approve**: Distinct `#0070f3` primary action button transitioning to `#50e3c2` on approval.

---

## 4. Rejection Signal for Phase 9 Training

Manual rejections feed directly into the **Phase 6 Failure Taxonomy**:
- **Storage Target:** `chrome.storage.local.manualRejections`
- **Record Structure:**
  ```js
  {
    id: "rej_1724851200000_abc12",
    rejected_at: "2026-08-28T12:00:00.000Z",
    source_post_id: "tweet_...",
    reply_text: "...",
    failure_tag: "FORCED_QUESTION", // One of 16 taxonomy tags
    strategy: "nuance",
    scores: { relevance: 7, accuracy: 8, ... },
    notes: null
  }
  ```
- **Capacity:** Rolling buffer of the last 200 rejections, readily accessible by Phase 9 voice & pattern learning modules.

---

## 5. Verification & Test Suite

```bash
npm test
```

### Coverage:
- **`src/tests/review.test.js`**:
  - `REQUIRE_HUMAN_APPROVAL` default truthiness check.
  - `recordManualRejection` record generation, unique ID assignment, and taxonomy validation.
  - Safe fallback to `GENERIC` when unknown tags are received.
  - Graceful null/empty handling.
- **Full Suite**: 14 test suites all passing (228 tests).
