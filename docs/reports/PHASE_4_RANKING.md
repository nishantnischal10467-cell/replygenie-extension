# PHASE 4 — Performance-Aware Ranking
## ReplyGenie Chrome Extension

**Completed:** 2026-08-28
**Tests:** 142 passed / 142 total (11 suites — 38 new ranker tests)
**Syntax check:** All files pass `node --check`
**Core principle:** Relevance is primary. Performance acts as a bounded additive bonus — never as an override.

---

## Executive Summary

Phase 4 adds **ReplyRanker** (`src/background/ranker.js`), a config-driven scoring layer that sits after Phase 3's `ReplyRetriever`. It takes the raw semantic candidates (unordered) and applies a multi-factor composite score so the best reply candidates — combining semantic relevance, topic fit, voice match, freshness, diversity, and engagement track record — surface at the top of the list.

---

## 1. Performance Classification

### Configurable Thresholds

```js
// src/background/ranker.js — PERFORMANCE_THRESHOLDS
var PERFORMANCE_THRESHOLDS = {
  OUTSTANDING_MIN: 10000,   // ≥ 10,000 impressions → OUTSTANDING
  MODERATE_MIN:    500,     //    500–9,999           → MODERATE
  // < 500                  → BASELINE
};
```

### Exact Spec Boundary Tests (verified in `ranker.test.js`)

| impressions | classification |
|---|---|
| `0` | BASELINE |
| `499` | BASELINE |
| `500` | **MODERATE** (inclusive lower bound) |
| `9999` | MODERATE |
| `10000` | **OUTSTANDING** (inclusive lower bound) |
| `999999` | OUTSTANDING |

---

## 2. Performance Score Formula

`computePerformanceScore(reply, pools, weights)` — produces a **normalized composite `performance_score` ∈ [0.0, 1.0]**.

### Step 1: Percentile Normalization

Each metric is normalized using **min-max percentile scaling** against the pool of all historical reply records (capped at 500 records for latency):

```
normalizedMetric = (value − poolMin) / (poolMax − poolMin)   [0.0 → 1.0]
```

Metrics normalized: `impressions`, `likes`, `reply_count`, `reposts`, `bookmarks`, `profile_visits`.

### Step 2: Weighted Sum

```
rawScore =
  (nImpressions   × w.impressions)    +
  (nLikes         × w.likes)          +
  (nReplyCount    × w.reply_count)    +
  (nReposts       × w.reposts)        +
  (nBookmarks     × w.bookmarks)      +
  (nProfileVisits × w.profile_visits)
```

### Step 3: Bonus / Penalty

```
normalizedScore = rawScore / sum(positive weights)
normalizedScore += author_reply_bonus  (when author replied to our reply)
normalizedScore -= negative_feedback_penalty  (when hide/block/mute detected)

performance_score = clamp(normalizedScore, 0.0, 1.0)
```

### Default Performance Weights (`DEFAULT_PERFORMANCE_WEIGHTS`)

> ⚠️ **TUNING REQUIRED**: These are conservative starting defaults. Re-tune after ≥ 200 replies with real engagement data. Surface in options panel.

| Weight Key | Default | Rationale |
|---|---|---|
| `impressions` | `0.30` | Raw reach — highest signal for distribution |
| `likes` | `0.25` | Explicit positive engagement |
| `reply_count` | `0.20` | Conversational pull — someone was moved to respond |
| `reposts` | `0.15` | Distribution amplification by others |
| `bookmarks` | `0.05` | Quality "save for later" signal |
| `profile_visits` | `0.05` | Downstream account growth |
| `author_reply_bonus` | `0.15` | Original author replied — strong quality signal |
| `negative_feedback_penalty` | `0.20` | Hide/block/mute — strong quality anti-signal |

---

## 3. `reply_impression_ratio`

```
reply_impression_ratio = reply_impressions / source_post_impressions
```

**Purpose:** Prevents a reply under a mega-viral tweet from being mislabeled OUTSTANDING on absolute impression count alone. A reply with 10,000 impressions under a 1,000,000-impression tweet has a ratio of **0.01** — correctly framing its relative reach.

**Availability:** `source_post_impressions` is a Phase 9 deliverable (scheduled X Analytics scrape). The field is set to `null` when unavailable and gracefully skipped in scoring — existing ranking is unaffected.

---

## 4. Composite Candidate Score Formula

`computeCandidateScore(candidate, inputs, performanceScore, weights)` — the **final ranking score ∈ [0.0, 1.0]**.

### Formula

```
relevance_base =
  (semantic_similarity × w.semantic_similarity) +
  (topic_similarity    × w.topic_similarity)    +
  (strategy_match      × w.strategy_match)      +
  (voice_similarity    × w.voice_similarity)    +
  (recency_score       × w.recency_score)       +
  (novelty_score       × w.novelty_score)

performance_bonus = min(
  performance_score × w.performance_bonus_weight,
  w.performance_bonus_cap                         ← hard cap
)

candidate_score = clamp(relevance_base + performance_bonus, 0.0, 1.0)
```

### Default Candidate Weights (`DEFAULT_CANDIDATE_WEIGHTS`)

> ⚠️ **TUNING REQUIRED**: Weights assume semantic similarity is the dominant signal. Adjust once voice similarity and strategy match become richer signals.

| Weight Key | Default | Rationale |
|---|---|---|
| `semantic_similarity` | `0.40` | Primary relevance signal (Phase 3 cosine score) |
| `voice_similarity` | `0.15` | Matches user's writing style |
| `topic_similarity` | `0.20` | Topic alignment bonus |
| `strategy_match` | `0.10` | Structural angle match |
| `recency_score` | `0.10` | Prefer newer replies (freshness) |
| `novelty_score` | `0.05` | MMR-lite diversity bonus |
| `performance_bonus_weight` | `0.25` | Maps perf_score → bonus magnitude |
| `performance_bonus_cap` | `0.20` | **Hard cap** — perf can add at most 0.20 |

### INVARIANT: Relevance Dominates Performance

**Tested in `ranker.test.js` — `relevance dominates` test.**

The formula is designed and tested so that a **high-relevance / low-performance reply always scores higher than a high-performance / low-relevance reply**.

```
High-relevance/low-perf:   semantic=0.92, topic=1.0, strategy=1.0, voice=0.85, perf=0.05
Low-relevance/high-perf:   semantic=0.12, topic=0.0, strategy=0.0, voice=0.1,  perf=0.99

→ relevance_base(high) >> performance_bonus(low-perf, max-capped at 0.20)
→ candidate_score(high-relevance) > candidate_score(high-performance)  ✓
```

The `performance_bonus_cap` (default: `0.20`) is the structural guarantee. Performance can shift a reply's rank within a tier, but cannot promote a semantically irrelevant reply above a semantically strong one.

---

## 5. Supporting Scores

### Recency Score
Exponential decay with configurable half-life (default: 60 days):
```
recency_score = exp(−λ × age_days),   λ = ln(2) / half_life_days
```
A reply posted today scores ≈ 1.0. A reply 60 days old scores ≈ 0.5. A 2-year-old reply scores < 0.05.

### Novelty Score (MMR-lite)
Penalizes candidates whose text closely resembles an already-selected candidate, preventing duplicate/near-duplicate replies from surfacing back-to-back. Uses Jaccard word-overlap by default; upgrades to cosine similarity when vector functions are available.

---

## 6. `rankCandidates` — Full Pipeline API

```javascript
/**
 * @param {Array<Object>} candidates      — Phase 3 ReplyRetriever output
 * @param {Object} queryAnalysis          — PostAnalyzer output (topic, intent, …)
 * @param {Array<Object>} performancePool — historical reply records for pool normalization
 * @param {Object} [options]              — weights.performance, weights.candidate, embedFn, similarityFn
 * @returns {Array<Object>}               — sorted descending by candidate_score
 */
rankCandidates(candidates, queryAnalysis, performancePool, options)
```

Each returned candidate is augmented with:

| Injected Field | Type | Description |
|---|---|---|
| `candidate_score` | `number` | Final composite score ∈ [0, 1] |
| `relevance_base` | `number` | Relevance component |
| `performance_bonus` | `number` | Capped performance addend |
| `performance_score` | `number` | Per-reply perf score ∈ [0, 1] |
| `performance_class` | `string` | `"outstanding"` / `"moderate"` / `"baseline"` |
| `impression_ratio` | `number\|null` | reply/source impression ratio (null until Phase 9) |
| `recency_score` | `number` | Freshness score ∈ [0, 1] |
| `novelty_score` | `number` | Diversity score ∈ [0, 1] |
| `score_components` | `Object` | All sub-scores for debugging |

---

## 7. Where to Tune Weights

All weights are exported constants from `ranker.js`. They are designed to be surfaced to the UI or overridden per-call.

**Short-term:** Pass `options.weights.performance` and `options.weights.candidate` overrides to `rankCandidates()` from `background.js` after loading from `chrome.storage`.

**Long-term (Phase 8+):** Build an automated weight-tuning loop using the `generation_runs` table's evaluator sub-scores correlated against real engagement data from the `replies` store.

**Tuning priority order:**
1. `semantic_similarity` weight — most impactful; raise if reply quality degrades
2. `impressions` weight in performance — lower if the account's viral replies are outliers
3. `author_reply_bonus` — raise once it proves predictive for account growth
4. `performance_bonus_cap` — keep ≤ 0.25 to preserve the relevance-dominance invariant

---

## 8. Test Suite

```bash
npm test
```

```
PASS src/tests/ranker.test.js
PASS src/tests/retrieval.test.js
... (10 other suites)

Test Suites: 11 passed, 11 total
Tests:       142 passed, 142 total
Snapshots:   0 total
Time:        1.416 s
```

### New Test Coverage (38 tests in `ranker.test.js`):
- **Spec boundary values**: 499/500/9999/10000 classification (exact)
- **Percentile normalization**: empty pool, equal pool, min/max/mid-range
- **Performance score**: engagement tiers, bonus, penalty, weight overrides, clamp, classification
- **Impression ratio**: source-post normalization, null when unavailable, viral scaling
- **Composite score INVARIANT**: high-relevance/low-perf beats high-perf/low-relevance
- **Performance bonus cap**: max addend never exceeds `performance_bonus_cap`
- **Recency decay**: just-created ≈ 1.0, past half-life < 0.5, very old ≈ 0
- **Novelty MMR-lite**: first candidate = 1.0, duplicate ≈ 0, diverse = high
- **Full pipeline**: all score fields injected, sorted descending
- **Config surface**: all weight constants exported and key-complete

---

## 9. Files Created and Modified

### Created
- `src/background/ranker.js` — ReplyRanker module
- `src/tests/ranker.test.js` — 38-test ranker suite
- `docs/reports/PHASE_4_RANKING.md` — this deliverable

### Modified
- `src/background/background.js` — added `importScripts("ranker.js")`
- `.github/workflows/lint.yml` — added `ranker.js` to syntax check
- `.github/workflows/release.yml` — added `ranker.js` to syntax check and zip packaging
