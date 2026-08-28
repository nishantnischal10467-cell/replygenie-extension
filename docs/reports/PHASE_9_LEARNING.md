# PHASE 9 — Performance Collection & Learning Loop
## ReplyGenie Chrome Extension

**Completed:** 2026-08-28  
**Tests:** 16 suites passing (all green)  
**Syntax check:** All files pass `node --check`  
**Core principle:** Asynchronous metrics ingestion via X's native DOM (no paid API), scraper breakage resilience, conceptual pattern mining, and human-in-the-loop ranking weight proposals.

---

## 1. Architecture Overview

```
Account Owner's Posted Replies
       │
       ▼
Scheduled Metrics Collection (1h, 6h, 24h, 72h cadence)
       │
       ├─► DOM Scraper (X Web native analytics view)
       │     ├─ Extracts impressions, likes, replies, reposts, bookmarks
       │     └─ Scraper Health Check (flags LIKELY_SCRAPER_BREAKAGE if >70% zero/missing)
       │
       ▼
Confidence Gate (`metrics_confidence` filter)
       │
       ├─► Exclude "missing" / "unreliable" reads from polluting the dataset
       └─► Reclassify "fresh" / "reliable" reads (OUTSTANDING / MODERATE / BASELINE)
             using Phase 4 thresholds & reply_impression_ratio
       │
       ▼
PatternMiner (`src/background/learning.js`)
       │
       ├─► Conceptual Feature Extraction (Hook type, technical depth, numbers, contrarian level)
       ├─► Account-Specific Takeaways (e.g., "Data points outperform questions by 3.8x")
       └─► Negative Pattern Extraction (Failure taxonomy avoidance directives)
       │
       ▼
Feedback Loops
       ├─► Voice Profile Retraining (`trainVoiceProfile()` in Phase 8)
       └─► Ranking Weight Proposals (`proposeRankingWeightAdjustments()` in Phase 4)
             └─ Logged to `chrome.storage.local.weightProposals` as "proposed"
             └─ NEVER auto-mutates production weights without approval
```

---

## 2. DOM Analytics Scraping & Reliability Guardrails

### Exact DOM Selectors Used
```js
var X_DOM_SELECTORS = {
  tweetArticle:   'article[data-testid="tweet"]',
  tweetText:      '[data-testid="tweetText"]',
  replyCount:     '[data-testid="reply"] span',
  repostCount:    '[data-testid="retweet"] span, [data-testid="unretweet"] span',
  likeCount:      '[data-testid="like"] span, [data-testid="unlike"] span',
  bookmarkCount:  '[data-testid="bookmark"] span',
  analyticsLink:  'a[href*="/analytics"]',
  viewsContainer: '[data-testid="app-text-transition-container"]',
  viewsAria:      '[aria-label*="views" i], [aria-label*="Analytics" i]',
};
```

### Fragility & Failure Mode Documentation:
1. **Account Owner vs. Third-Party Data**:
   - **Account Owner's Replies**: X always renders full view counts and analytics links to logged-in authors.
   - **Third-Party / Parent Posts**: Views may be lazy-loaded or omitted on non-top-level timeline views. `reply_impression_ratio` gracefully treats missing parent views as `null` to avoid dividing by zero or discarding valid reply numbers.
2. **DOM Redesign Resilience (`checkScraperHealth`)**:
   - If an X DOM update alters data-testid attributes, standard scrapers fail silently by writing zeros.
   - `checkScraperHealth()` checks the proportion of missing/zero impressions across tracked batches ($\ge 5$ items). If zero/missing reads exceed **70%**, an explicit `LIKELY_SCRAPER_BREAKAGE` alert is logged and zero-metrics are isolated from polluting the dataset.

---

## 3. Scheduled Collection Cadence

Impression counts accrue gradually over multiple days. The extension visits tracked replies at 4 lifecycle intervals:

| Interval | Target Window | Purpose |
|---|---|---|
| **Pass 1** | $\approx 1$ hour | Immediate initial traction & author acknowledgment |
| **Pass 2** | $\approx 6$ hours | Mid-day engagement inflection check |
| **Pass 3** | $\approx 24$ hours | Primary viral plateau & mature ratio calculation |
| **Pass 4** | $\approx 72$ hours | Final archival classification |

---

## 4. PatternMiner: Learning Concepts Over Literal Tropes

Rather than memorizing specific strings or hook formulas, `PatternMiner` extracts abstract conceptual properties:
- **Hook Taxonomy**: `data_point`, `contrarian_take`, `personal_experience`, `question`, `observation`.
- **Dimensional Scores**: `specificity` (0.0–1.0), `contrarian_level` (0.0–1.0), `technical_depth` (0.0–1.0).
- **Synthesized Account Takeaways**: Outputs high-level rules, e.g.:
  > *"Replies providing specific metrics (latency, MRR, percentages) achieve 4.2x higher impressions on engineering topics than generic questions."*

---

## 5. Ranking Weight Proposals & Approval Flow

### Invariant: Zero Silent Production Mutations
- When pattern mining identifies strong correlations between specific scoring dimensions (e.g. `performance_score` or `strategy_match`) and OUTSTANDING performance, it produces a **Proposal Record**:
  ```js
  {
    id: "prop_1724851200000_abc12",
    created_at: "2026-08-28T13:00:00.000Z",
    status: "proposed", // Requires manual confirmation before activation
    current_weights: { semantic_similarity: 0.30, performance_score: 0.20, ... },
    proposed_weights: { semantic_similarity: 0.25, performance_score: 0.25, ... },
    rationale: "Increased performance_score weight (+0.05) due to strong signal correlation in OUTSTANDING bucket.",
    sample_size: 28
  }
  ```
- **Storage Target**: `chrome.storage.local.weightProposals` (rolling buffer of 50 proposals).
- **Approval**: Exposed in extension settings/options for operator review (`applyWeightProposal()`).

---

## 6. Verification & Test Suite

```bash
npm test
```

### Coverage:
- **`src/tests/learning.test.js`**: 8 comprehensive tests covering metric parsing, scraper health checks, scheduled cadence, confidence filtering, concept mining, negative pattern extraction, and weight proposal generation.
- **Full Suite**: 16 test suites, 246 tests all green.
