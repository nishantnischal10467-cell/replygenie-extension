# PHASE 5 — Generation, Adaptation & Confidence Routing
## ReplyGenie Chrome Extension

**Completed:** 2026-08-28  
**Tests:** 194 passed / 194 total (12 suites — 50 new Phase 5 tests)  
**Syntax check:** All files pass `node --check`  
**Flag:** `ENABLE_INTELLIGENT_REPLY_ENGINE` — **OFF by default**

---

## 1. Architecture Overview

```
Source Post
    │
    ▼
PostAnalyzer (Phase 3) ─── analysis { topic, intent, sentiment, … }
    │
    ▼
Embeddings + ReplyRetriever (Phase 3) ─── ~30 raw candidates
    │
    ▼
ReplyRanker (Phase 4) ─── ranked candidates with candidate_score
    │
    ▼
ConfidenceRouter ─── ADAPT │ INSPIRE │ GENERATE
    │               │
    │     ┌─────────┼─────────┐
    │     ▼         ▼         ▼
    │  ADAPT     INSPIRE   GENERATE
    │     │         │         │
    │     ▼         └────┬────┘
    │  Adapter           │
    │  (1 call)     Stage 1: selectStrategy (1 call)
    │                    │
    │               Stage 2: generateCandidates (1 call → 3 replies)
    │                    │
    └────────────── stripBannedOpener → surface reply
```

When `ENABLE_INTELLIGENT_REPLY_ENGINE = false` (default), the pipeline is bypassed entirely and execution is byte-for-byte identical to pre-Phase-3 behaviour.

---

## 2. Confidence Router (`src/background/router.js`)

### Decision Logic

```
sim  = topCandidate.similarity_score

if no candidates:          → GENERATE
if sim < MEDIUM_BAND_LOW:  → GENERATE
if MEDIUM_BAND_LOW ≤ sim < HIGH_CONFIDENCE_SIMILARITY:
                           → INSPIRE  (no further guard checks)
if sim ≥ HIGH_CONFIDENCE_SIMILARITY:
    run ALL guards:
      low_performance | stale | contradiction_risk |
      too_similar_to_recent | low_novelty | low_recency
    if any guard triggered → INSPIRE  (candidate still has signal)
    else                   → ADAPT
```

### Default Routing Thresholds (`DEFAULT_ROUTING_THRESHOLDS`)

> ⚠️ **TUNING**: Calibrate after ≥200 ranked replies with real engagement data.

| Threshold | Default | Meaning |
|---|---|---|
| `HIGH_CONFIDENCE_SIMILARITY` | `0.90` | ≥ this → eligible for ADAPT |
| `MEDIUM_BAND_LOW` | `0.80` | ≥ this → INSPIRE band |
| `MEDIUM_BAND_HIGH` | `0.90` | = `HIGH_CONFIDENCE_SIMILARITY` |
| `MIN_PERFORMANCE_SCORE` | `0.20` | Minimum perf to qualify for ADAPT |
| `MAX_STALENESS_DAYS` | `90` | Candidates older → stale |
| `NOVELTY_FLOOR` | `0.30` | ADAPT requires at least this novelty |
| `RECENCY_FLOOR` | `0.10` | ADAPT requires at least this recency |
| `RECENTLY_POSTED_SIMILARITY` | `0.80` | Jaccard overlap threshold vs recent replies |

All thresholds are config values — pass an override object to `routeCandidate()` to tune without modifying source.

### Routing Guards (applied only for ≥ HIGH_CONFIDENCE candidates)

| Guard | Trigger | Action |
|---|---|---|
| `low_performance` | `performance_score < MIN_PERFORMANCE_SCORE` | Fall to INSPIRE |
| `stale` | age > `MAX_STALENESS_DAYS` OR dated year reference > 2 years old | Fall to INSPIRE |
| `contradiction_risk` | Disagreement strategy + topic matches current post perfectly | Fall to INSPIRE |
| `too_similar_to_recent` | Jaccard overlap with recent posted reply ≥ threshold | Fall to INSPIRE |
| `low_novelty` | `novelty_score < NOVELTY_FLOOR` | Fall to INSPIRE |
| `low_recency` | `recency_score < RECENCY_FLOOR` | Fall to INSPIRE |

Note: guards trigger **INSPIRE not GENERATE** — the candidate still contains useful signal even when it can't be directly adapted.

---

## 3. ReplyAdapter (`src/background/adapter.js`)

### Purpose
Adapts a stored high-confidence candidate for a new post context via a **single OpenAI call**. This is **not a copy** — the adapter extracts the structural/argumentative move and rewrites it entirely for the current post.

### Pre-Adaptation Safety Checks (`preAdaptationCheck`)

| Check | Condition | Action |
|---|---|---|
| Stale year reference | Reply text contains `20XX` year > 2 years old | Refuse adaptation; fall to INSPIRE/GENERATE |
| `personal_insight` without context | Strategy = `personal_insight` AND voiceSamples empty | Refuse; facts would need to be manufactured |

### Strategy-to-Instruction Mapping (`STRATEGY_ADAPTATION_HINTS`)

Each of the 15 reply strategies has an explicit adaptation instruction telling the model **how** to extract and reapply the structural move. Examples:

- `concrete_example`: *"Use the structural form (giving an example) but surface an example relevant to THIS post."*
- `data_backed_observation`: *"Only reuse data points present in the verified context. Do not invent or transfer stats between contexts."*
- `personal_insight`: *"Keep the personal observation but ONLY include facts present in the verified user context provided."*

### Prompt Isolation
- Source post text: passed through `buildPromptContext()` → wrapped in `[SOURCE_POST]...[/SOURCE_POST]`
- Candidate text: wrapped in `[EXAMPLE_REPLY_TO_ADAPT]...[/EXAMPLE_REPLY_TO_ADAPT]`, truncated to 500 chars
- No raw string interpolation of any untrusted field

### Prompt Version
`ADAPTER_PROMPT_VERSION = "adapter-v1.0.0"` — stored in `generation_runs.prompt_version`

---

## 4. Two-Stage ReplyGenerator (`src/background/generator.js`)

### Stage 1: Strategy Selection

**Purpose:** Determine the single best reply strategy before writing any text.

**Call parameters:**
- Model: `gpt-4o-mini`
- Max tokens: `200` (small JSON object only)
- Input: source post (via `buildPromptContext`), PostAnalyzer analysis, top-ranked candidate strategies

**Return (JSON):**
```json
{
  "strategy_id": "nuance",
  "rationale": "The post makes an absolute claim that benefits from precise qualification.",
  "angle": "Point out the one condition where the claim stops holding true."
}
```

**Fallback:** If JSON parse fails, regex-extracts `strategy_id`. If extraction fails → defaults to `specific_agreement_extension`.

**Prompt Version:** `GENERATOR_STAGE1_PROMPT_VERSION = "generator-stage1-v1.0.0"`

#### Stage 1 Strategy Catalogue (15 strategies)

| ID | Usability |
|---|---|
| `specific_agreement_extension` | always |
| `respectful_disagreement` | always |
| `contrarian_observation` | always |
| `concrete_example` | always |
| `useful_correction` | always |
| `personal_insight` | requires_voice_context |
| `short_witty_observation` | always |
| `data_backed_observation` | always |
| `practical_takeaway` | always |
| `nuance` | always |
| `pattern_recognition` | always |
| `story_fragment` | always |
| `community_building_response` | always |
| `genuine_question` | conditional |

---

### Stage 2: Reply Generation

**Purpose:** Generate **3 structurally diverse candidate replies** using the confirmed strategy.

**Call parameters:**
- Model: `gpt-4o-mini`
- Max tokens: `min(3 × length_max_tokens + 50, 800)` — prevents runaway cost
- INSPIRE path: includes inspiration candidate in `[INSPIRATION_REPLY]...[/INSPIRATION_REPLY]` block

**Return (JSON):**
```json
{
  "candidates": [
    { "text": "reply 1 text" },
    { "text": "reply 2 text" },
    { "text": "reply 3 text" }
  ]
}
```

**Fallback:** Regex extraction of `"text"` fields if JSON parse fails. Falls back to raw content as single candidate if regex also fails.

**Prompt Version:** `GENERATOR_STAGE2_PROMPT_VERSION = "generator-stage2-v1.0.0"`

---

### Stage 2: Core Generation System Prompt (verbatim from spec)

```
You are writing one authentic reply to an X post.
Your job is not to praise the author.
Your job is to contribute one genuinely useful thought.
Read the post carefully.
Identify the most interesting specific idea.
Add something that was not already said.
Prefer a clear observation, useful extension, concrete example, respectful
disagreement, nuance, or concise insight.
Do not restate the post.
Do not begin with generic praise.
Do not ask a question unless a question is genuinely useful.
Never invent facts or personal experiences that are not present in the provided
verified context.
Never manufacture engagement.
Write like a thoughtful person participating in a real community.
One strong idea is better than three weak ones.
Do not force a conclusion.
Do not append 'thoughts?', 'agree?', or similar engagement bait.
Use the provided voice profile without copying any historical example verbatim.
```

Pinned at `GENERATION_SYSTEM_PROMPT_TEMPLATE` in `generator.js` — tested verbatim to prevent accidental drift.

### Additional Stage 2 Injections

| Injected Content | Source | Purpose |
|---|---|---|
| Source post | `buildPromptContext(context)` | Data-isolated, never raw |
| Author handle | profile | Context |
| Selected strategy + angle | Stage 1 output | Structural direction |
| Voice profile + samples | `profile.voiceSamples` (last 8) | Voice matching |
| Positive examples | ranked candidates with `performance_score > 0.4` + same strategy | Structural inspiration |
| Negative examples | ranked candidates with `performance_score < 0.1` | Anti-pattern avoidance |
| Anti-repetition openers | last 10 recent replies | Opener diversity |
| Question probability | `profile.question_frequency` (default 10–20%) | Question rate control |
| Length constraint | `getLengthConfig(profile.length)` | Injected twice (top + bottom) |

---

## 5. Error Handling & Fallback Strategy

Every error in the intelligent pipeline falls back gracefully:

```
Phase 3-4 pipeline error (analyze/embed/retrieve/rank) → _runClassicGeneration()
Stage 1 (strategy selection) error                     → _runClassicGeneration()
Stage 2 (generation) error                             → _runClassicGeneration()
Adapter refused (pre-check)                            → falls to INSPIRE path
Adapter API error                                      → _runClassicGeneration()
All generated candidates empty                         → _runClassicGeneration()
```

**The user always receives a reply.** The intelligent engine degrades silently to the classic single-call path in all error conditions.

---

## 6. Prompt Version Tracking (Phase 2 `generation_runs`)

Every intelligent generation logs to `generation_runs`:

```js
{
  prompt_version:    "generator-stage2-v1.0.0",  // or adapter-v1.0.0
  model:             "gpt-4o-mini",
  selected_strategy: "nuance",
  extra: {
    route:           "generate",   // adapt | inspire | generate
    strategy:        "nuance",
    guards:          [],           // which guards triggered
    prompt_versions: {
      stage1: "generator-stage1-v1.0.0",
      stage2: "generator-stage2-v1.0.0",
    },
  },
}
```

This enables exact prompt-version-to-quality correlation in the eval loop.

---

## 7. Where to Tune

### Routing Thresholds
Override via `routeCandidate(topCandidate, analysis, recentReplies, customThresholds)`.  
Surface in `options.html` once the Phase 6 UI lands.

### When to Enable
Set `ENABLE_INTELLIGENT_REPLY_ENGINE: true` in `chrome.storage.sync.featureFlags` only after:
1. ≥10 reply records exist in IndexedDB (retriever needs a population)
2. End-to-end smoke test passes with a live API key
3. Governor caps are set (prevent cost runaway on Stage 1 + Stage 2 combined calls)

### Weight-Tuning Priority (after ≥200 replies)
1. `HIGH_CONFIDENCE_SIMILARITY` — raise if adapted replies feel irrelevant
2. `MIN_PERFORMANCE_SCORE` — lower if too few candidates reach ADAPT
3. `MAX_STALENESS_DAYS` — lower if topics evolve fast in your niche

---

## 8. Test Suite

```bash
npm test
```

```
PASS src/tests/generation.test.js
... (11 other suites all passing)

Test Suites: 12 passed, 12 total
Tests:       194 passed, 194 total
Time:        2.09 s
```

### New Test Coverage (50 tests in `generation.test.js`):
- Router basic routing (null, below-band, mid-band, high-confidence)
- All 6 routing guards (perf, staleness, contradiction, repetition, novelty, recency)
- Threshold configurability
- `checkStaleness`: fresh, age-exceeded, dated-year-reference, recent-year
- `isTooSimilarToRecent`: empty, identical, different
- `preAdaptationCheck`: all three refusal conditions
- Adapter system prompt: strategy hint, voice samples, no-copy and no-fabrication rules
- Adapter user message: `[SOURCE_POST]` isolation, `[EXAMPLE_REPLY_TO_ADAPT]` isolation, 500-char cap
- Strategy catalogue: count ≥14, no duplicates, all spec-mandated ids present
- Stage 1 system prompt: all strategy ids listed, JSON format, guard rules
- Stage 2 system prompt: spec-mandated generation prompt verbatim, 3 candidates, anti-repetition, positive + negative examples
- Prompt version constants exported and non-empty
- `ENABLE_INTELLIGENT_REPLY_ENGINE` defaults to false

---

## 9. Files Created and Modified

### Created
- [`src/background/router.js`](file:///c:/Users/getgo/Downloads/replygenie-extension/src/background/router.js) — Confidence Router
- [`src/background/adapter.js`](file:///c:/Users/getgo/Downloads/replygenie-extension/src/background/adapter.js) — ReplyAdapter
- [`src/background/generator.js`](file:///c:/Users/getgo/Downloads/replygenie-extension/src/background/generator.js) — Two-stage ReplyGenerator
- [`src/tests/generation.test.js`](file:///c:/Users/getgo/Downloads/replygenie-extension/src/tests/generation.test.js) — 50-test Phase 5 suite
- [`docs/reports/PHASE_5_GENERATION.md`](file:///c:/Users/getgo/Downloads/replygenie-extension/docs/reports/PHASE_5_GENERATION.md) — this deliverable

### Modified
- [`src/background/background.js`](file:///c:/Users/getgo/Downloads/replygenie-extension/src/background/background.js) — `importScripts` for 3 new modules + `_runIntelligentReplyEngine` orchestrator
- [`src/background/flags.js`](file:///c:/Users/getgo/Downloads/replygenie-extension/src/background/flags.js) — updated flag comment
- [`.github/workflows/lint.yml`](file:///c:/Users/getgo/Downloads/replygenie-extension/.github/workflows/lint.yml) — Phase 5 files in syntax check
- [`.github/workflows/release.yml`](file:///c:/Users/getgo/Downloads/replygenie-extension/.github/workflows/release.yml) — Phase 5 files in syntax check + zip packaging
