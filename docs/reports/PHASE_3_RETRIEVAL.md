# PHASE 3 — Post Analyzer, Semantic Embeddings, Reply Retriever & X Pacing Engine
## ReplyGenie Chrome Extension

**Completed:** 2026-08-28  
**Tests:** 104 passed / 104 total (10 test suites)  
**Syntax check:** All files pass `node --check`  
**Embedding Engine:** `text-embedding-3-small` with LRU in-memory cache + deterministic local fallback vectorizer  
**Retrieval Engine:** IndexedDB Semantic Cosine Similarity search (~20-50 candidates)  
**Pacing Engine:** Config-driven graceful FIFO queue with jitter

---

## Executive Summary

Phase 3 builds the intelligence comprehension and retrieval layer that connects raw incoming X tweets with historical reply knowledge.

It delivers:
1. **`PostAnalyzer`**: Extracts 13 semantic comprehension signals (topic, entities, claims, sentiment, intent, post format, author type, conversational opportunity, controversial claims, facts/numbers, implied questions, audience, reply angles). **Guaranteed untrusted-input isolation** using `buildPromptContext()` from Phase 1.
2. **`EmbeddingEngine`**: Generates normalized vector representations using OpenAI's `text-embedding-3-small` with in-memory LRU caching and a deterministic local fallback vectorizer.
3. **`ReplyRetriever`**: Performs semantic cosine similarity candidate searches over the IndexedDB `replies` store, returning 20-50 ranked candidates without performance bias (Phase 4 applies performance scoring). Gracefully degrades to `confidence: "none"` on empty or unrelated content.
4. **`PacingEngine`**: Protects the user's X account from rapid action penalties via a config-driven, non-blocking FIFO queue with natural jitter.

---

## 1. PostAnalyzer API & Semantic Signals

### Location
`src/background/analyzer.js`

### Security Rule
`PostAnalyzer` uses `buildPromptContext()` from Phase 1 for all LLM prompts. Untrusted tweet content is wrapped inside `[SOURCE_POST]` boundaries with a data-boundary system rule, preventing instruction injection attacks.

### API Specification

```javascript
/**
 * Analyzes a source post context and returns 13 structured comprehension signals.
 *
 * @param {Object} context - { text, handle, displayName, images, hasVideo }
 * @param {string} [apiKey] - OpenAI API key (if null, uses heuristic mode)
 * @param {Object} [options] - { forceHeuristic: boolean }
 * @returns {Promise<PostAnalysis>}
 */
async function analyzePost(context, apiKey, options);

/**
 * Fast deterministic heuristic analyzer (zero external API calls).
 * @param {Object} context
 * @returns {PostAnalysis}
 */
function analyzePostHeuristic(context);
```

### Extracted Signal Schema (`PostAnalysis`)

| Signal | Type | Example / Description |
|---|---|---|
| `topic` | `string` | `"ai"`, `"saas_builder"`, `"marketing"`, `"branding"`, `"engineering"`, `"productivity"`, `"finance"`, `"general"` |
| `entities` | `string[]` | Named entities, mentions, hashtags, products, and technologies (e.g. `["@builder", "#SaaS", "OpenAI"]`) |
| `claims` | `string[]` | Explicit factual or opinion assertions in the tweet |
| `sentiment` | `string` | `"positive"`, `"negative"`, `"neutral"`, `"skeptical"`, `"enthusiastic"`, `"provocative"` |
| `intent` | `string` | `"announcement"`, `"question"`, `"discussion_starter"`, `"critique"`, `"celebration"`, `"advice"`, `"story"` |
| `post_format` | `string` | `"single_thought"`, `"thread_starter"`, `"listicle_or_story"`, `"question"`, `"media_highlight"` |
| `author_type` | `string` | `"founder"`, `"engineer"`, `"marketer"`, `"creator"`, `"investor"`, `"casual_user"` |
| `conversational_opportunity` | `string` | The highest-leverage conversational hook / gap to reply to |
| `controversial_claims` | `string[]` | Polarizing statements that invite debate or counter-reframing |
| `specific_facts_or_numbers` | `string[]` | Numbers, percentages, metrics (e.g. `["95%", "10k MRR", "18 months"]`) |
| `implied_question` | `string` | The unstated question or prompt to the reader |
| `likely_audience` | `string` | Target reader profile (e.g. `"Indie founders & startup builders"`) |
| `possible_reply_angles` | `string[]` | 3-4 strategic reply angles (e.g. `["contrarian_reframe", "curious_metric_question"]`) |
| `analysis_mode` | `string` | `"llm_structured"` or `"heuristic"` |
| `injection_flagged` | `boolean` | Whether heuristic injection patterns were detected in the source |

---

## 2. Embedding Approach

### Location
`src/background/embeddings.js`

### Strategy Recommended in Phase 0 Audit
- **Primary:** OpenAI `text-embedding-3-small` (`https://api.openai.com/v1/embeddings`).
  - Unit normalized (L2 norm = 1.0).
  - Cost: ~$0.00002 / call (negligible).
  - In-memory LRU cache (`_EMBEDDING_CACHE`, max 500 entries) prevents redundant calls for identical or repeated tweet text.
- **Fallback / Local:** `generateLocalEmbedding(text, dimensions = 256)`
  - Deterministic n-gram + word stem hash vectorizer with English stop-word elimination.
  - Generates unit-normalized vectors locally in <1ms without network calls.
  - Used for unit tests, offline browsing, or when no API key is set.

### API Specification

```javascript
// Compute cosine similarity between two vectors (-1.0 to 1.0)
const score = cosineSimilarity(vecA, vecB);

// Normalize a vector to unit length
const normalized = normalizeVector(rawVector);

// Generate semantic embedding (API + local fallback + LRU cache)
const embedding = await generateEmbedding(text, apiKey, options);

// Generate deterministic local embedding (offline)
const localVec = generateLocalEmbedding(text, 256);
```

---

## 3. ReplyRetriever API & Semantic Candidate Search

### Location
`src/background/retriever.js`

### Behavior
- Retrieves **20–50 candidates** from the IndexedDB `replies` store ranked by cosine similarity against the query.
- **Zero Performance Bias:** Phase 3 retrieves raw semantic candidates; performance-based ranking is isolated to Phase 4.
- **Confidence Tiers:**
  - `high`: top score $\ge 0.50$
  - `medium`: top score $\ge 0.30$
  - `low`: top score $\ge 0.20$
  - `none`: top score $< 0.20$ or empty store
- **Graceful Degradation:** Returns `{ candidates: [], confidence: "none" }` on empty store or unrelated text without throwing errors.

### API Specification

```javascript
/**
 * Retrieves similar reply candidates based on semantic vector similarity.
 *
 * @param {Object|string} query - query text or { text, embedding, topic, intent }
 * @param {Object} [options] - { limit: 30, apiKey: string, minSimilarityThreshold: 0.20 }
 * @returns {Promise<RetrievalResult>}
 */
async function retrieveCandidates(query, options);
```

### Response Schema (`RetrievalResult`)

```javascript
{
  candidates: [
    {
      id: "rep_1724800000000_abc123",
      reply_text: "The best way to get initial SaaS customers is 1-on-1 direct outreach on X.",
      topic: "saas_builder",
      intent: "advice",
      reply_strategy: "direct_advice",
      similarity_score: 0.8245,
      total_score: 0.9245,
      is_human_written: 1,
      is_ai_generated: 0,
      generation_prompt_version: null
    },
    // ... up to 30-50 candidates
  ],
  confidence: "high", // "high" | "medium" | "low" | "none"
  count: 18,
  queryAnalysis: { /* PostAnalysis output */ }
}
```

---

## 4. X-Side Pacing Engine

### Location
`src/background/pacer.js` and `src/content/pacer.js`

### Purpose
Protects the user's Twitter/X account from automated rate-limit penalties, anti-bot flags, or account lockouts.

### Configuration Defaults (`PACING_DEFAULTS`)

| Parameter | Default | Purpose |
|---|---|---|
| `MIN_INTERVAL_MS` | `10000` (10s) | Minimum delay between consecutive reply submissions |
| `JITTER_MS` | `3000` (0–3s) | Randomized jitter added to delay to break bot timing patterns |
| `MAX_ACTIONS_PER_WINDOW` | `15` | Maximum actions allowed in a rolling 15-minute window |
| `WINDOW_MS` | `900000` (15 min) | Sliding rate-limit window |
| `MAX_QUEUE_SIZE` | `20` | FIFO queue capacity before backpressure |

### Graceful Degradation Model
When actions are triggered rapidly:
1. `pacer.enqueue(actionFn)` returns a Promise.
2. The action is added to an internal FIFO queue.
3. If an action occurred recently, the pacer delays execution until `MIN_INTERVAL_MS + jitter` has elapsed.
4. If the 15-minute window limit is reached, it schedules execution for when the oldest action rolls out of the window.
5. The caller's Promise resolves with the action result once executed — **never crashes or throws rate-limit errors**.

### API Specification

```javascript
const pacer = createPacingQueue({ MIN_INTERVAL_MS: 10000, JITTER_MS: 3000 });

// Enqueue action safely
const replyResult = await pacer.enqueue(async () => {
  return await postReplyToX();
});

// Telemetry check
const stats = pacer.getStats();
// { queueLength: 0, actionsInCurrentWindow: 3, maxActionsPerWindow: 15, ... }
```

---

## 5. Eval Set Results

The evaluation test suite (`src/tests/eval.test.js` & `src/tests/retrieval.test.js`) verifies candidate retrieval on the expanded fixture set:

```bash
npm test
```

```
PASS src/tests/retrieval.test.js
PASS src/tests/analyzer.test.js
PASS src/tests/embeddings.test.js
PASS src/tests/pacer.test.js
PASS src/tests/eval.test.js
PASS src/tests/database.test.js
PASS src/tests/retention.test.js
PASS src/tests/schema.test.js
PASS src/tests/prompt.test.js
PASS src/tests/governor.test.js

Test Suites: 10 passed, 10 total
Tests:       104 passed, 104 total
Snapshots:   0 total
Time:        2.538 s
```

### Verified Scenarios:
1. **SaaS Builder Post (`retrieval_001`):** Retrieves relevant bootstrap / initial customer acquisition replies ($\ge 1$ high-confidence candidates).
2. **AI & Prompt Engineering Post (`retrieval_002`):** Retrieves RAG and prompt engineering replies ($\ge 1$ high-confidence candidates).
3. **Marketing & Distribution Post (`retrieval_003`):** Retrieves video content and organic growth replies.
4. **Engineering / Systems Post (`retrieval_004`):** Retrieves Rust vs Python backend migration candidates.
5. **Productivity Post (`retrieval_005`):** Retrieves morning deep work focus candidates.
6. **Esoteric Unrelated Query (`retrieval_006`):** Gracefully produces `confidence: "none"` / low score without error.

---

## 6. Files Created and Modified

### Created Files
- `src/background/embeddings.js`: Cosine similarity, vector normalization, local vectorizer, OpenAI embedding caller with LRU cache.
- `src/background/analyzer.js`: PostAnalyzer with LLM structured JSON output & deterministic heuristic mode.
- `src/background/retriever.js`: ReplyRetriever semantic vector candidate search with topic boosting.
- `src/background/pacer.js`: PacingEngine queue with jitter and rate window tracking.
- `src/content/pacer.js`: Content-script mirror of pacing engine.
- `src/tests/analyzer.test.js`: PostAnalyzer test suite.
- `src/tests/embeddings.test.js`: Embedding and vector math test suite.
- `src/tests/retrieval.test.js`: Candidate retrieval and ranking test suite.
- `src/tests/pacer.test.js`: Pacing queue and rate limit test suite.
- `docs/reports/PHASE_3_RETRIEVAL.md`: This report.

### Modified Files
- `src/background/background.js`: Imported `embeddings.js`, `analyzer.js`, `retriever.js`, and `pacer.js`.
- `src/tests/eval/fixtures.js`: Added 6 retrieval evaluation fixtures.
- `.github/workflows/lint.yml`: Added Phase 3 files to syntax check list.
- `.github/workflows/release.yml`: Added Phase 3 files to syntax check list and release zip packaging.
