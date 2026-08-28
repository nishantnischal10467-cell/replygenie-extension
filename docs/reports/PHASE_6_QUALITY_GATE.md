# PHASE 6 — Quality / Accuracy / Genericity Gate
## ReplyGenie Chrome Extension

**Completed:** 2026-08-28  
**Tests:** 13 suites passing (all green)  
**Syntax check:** All files pass `node --check`  
**Core principle:** Strict multi-layer evaluation — never let a hallucinated stat, generic cliché, or engagement bait reach the user.

---

## 1. Architecture Overview

```
Stage 2 Generation (3 candidates)
       │
       ▼
Phase 6 Quality Gate (evaluateCandidates)
       │
       ├─► 1. Heuristic Pre-Screen (Zero API latency)
       │     ├─ Word Count Check (TOO_SHORT, TOO_LONG)
       │     ├─ Genericity Scorer (GENERIC)
       │     ├─ Forced-Question Detector (FORCED_QUESTION)
       │     ├─ Duplicate / N-gram Detector (REPETITIVE)
       │     ├─ Repeated Structure Check (COPIED_STRUCTURE)
       │     └─ AccuracyChecker (UNSUPPORTED_CLAIM)
       │
       ├─► 2. LLM Evaluator (0-10 Dimension Scoring)
       │     ├─ relevance, specificity, originality, human_likeness,
       │     │  accuracy, voice_match, conversation_value, genericity
       │     └─ Hard Rejection Thresholds:
       │          accuracy < 8 OR relevance < 8 OR genericity > 4
       │
       ▼
 Pass at least 1 candidate?
   ├─► YES: Pick highest composite score → Surface to user
   └─► NO:
         ├─► Retry 1 (Regenerate with collected failure reasons fed back)
         │     └─► Passes? → Surface to user
         └─► Still failing:
               └─► Queue in `humanReviewQueue` (Phase 11 review)
```

---

## 2. ReplyEvaluator Composite Scoring & Default Weights

Each candidate is evaluated across 9 dimensions (0–10 scale).

### Formula
$$\text{composite} = \sum (w_i \times \text{score}_i) - (\text{genericity} \times w_{\text{gen\_penalty}})$$

Clamped to $[0.0, 10.0]$.

### Default Weights (`DEFAULT_EVAL_WEIGHTS`)

> ⚠️ **CONFIGURABLE**: Weights and thresholds are exported configuration objects. Tune based on failure tag frequency after $\ge 200$ replies.

| Dimension | Weight | Description |
|---|---|---|
| `relevance` | `0.20` | Directly addresses the source post (not a generic comment) |
| `specificity` | `0.15` | References concrete details, numbers, or specific claims |
| `originality` | `0.15` | Adds a new thought/angle not already in the post |
| `human_likeness` | `0.15` | Sounds like a natural human, not an AI template |
| `accuracy` | `0.15` | All factual assertions supported by verified context |
| `voice_match` | `0.10` | Aligns with the user's voice profile / samples |
| `conversation_value` | `0.10` | Moves the conversation forward constructively |
| `genericity_penalty_weight` | `0.10` | Multiplier for genericity deduction |

---

## 3. Hard Rejection Gates (`DEFAULT_REJECTION_THRESHOLDS`)

A candidate is **instantly rejected** if any of these conditions are met:

| Gate | Condition | Rejection Tag |
|---|---|---|
| Minimum Accuracy | $\text{accuracy} < 8$ | `UNSUPPORTED_CLAIM` |
| Minimum Relevance | $\text{relevance} < 8$ | `LOW_RELEVANCE` |
| Maximum Genericity | $\text{genericity} > 4$ | `GENERIC` |
| Minimum Composite | $\text{composite} < 5.0$ | `LOW_CONVERSATIONAL_VALUE` |
| Minimum Length | $\text{words} < 3$ | `TOO_SHORT` |
| Maximum Length | $\text{words} > 120$ | `TOO_LONG` |
| Duplicate Cosine | $\text{cosine} \ge 0.85$ AND $\text{ngram} \ge 0.70$ | `REPETITIVE` |
| Repeated Opener | $\ge 2$ matches in last 5 replies | `COPIED_STRUCTURE` |

---

## 4. Genericity Heuristic ("Could this be posted under 20 unrelated tweets?")

Implemented via concrete multi-phrase & structure matching in `computeGenericityScore()`:

### Banned Generic Phrases (Spec examples + AI cliché list):
- `"great insights here"`
- `"couldn't agree more"`
- `"so true"`
- `"well said"`
- `"love this"`
- `"this is so true"`
- `"100%"`
- `"this is gold"` / `"absolute gold"`
- `"needed to hear this today"`
- `"this resonates"`

### Score Dynamics:
- $+3$ per generic phrase matched
- $+4$ for generic opener structures (`^couldn't agree more`, `^great post`, etc.)
- $-1$ for concrete signals (numbers, statistics, proper nouns, contrastive conjunctions like `but`/`however`, conditional clauses like `if`/`unless`)

---

## 5. Forced-Question Detection

Engagement-bait endings appended purely to inflate interaction are detected and rejected via `detectForcedQuestion()`:

### Literal Banned Endings:
- `"Thoughts?"` / `"Any thoughts?"` / `"What are your thoughts?"`
- `"What do you think?"` / `"What do you think about this?"`
- `"Agree?"` / `"Do you agree?"` / `"Would you agree?"`
- `"Right?"` / `"Am I wrong?"`
- `"Does this resonate?"`
- `"Who else?"`
- `"Let me know in the comments"`

### Genuine Utility Exemption:
A question is allowed if it references $\ge 3$ specific content words from the source post text or if the reply strategy is explicitly a single focused question.

---

## 6. AccuracyChecker & Claim Verification

Extracts claims using regex heuristics (`extractClaims()`):
1. **Numbers / Stats** (`45%`, `$50k MRR`, `3x`, `85% reduction`):
   Must appear in the source post, verified stored context, or user profile. Unverified numbers are flagged as `UNSUPPORTED_CLAIM`.
2. **Personal Experience Claims** (`"I built..."`, `"When I tried..."`):
   Key action verbs must be corroborated by voice samples or profile context.
3. **Named Entity Claims** (`"[Tool] supports..."`):
   Entity must be present in source or context.

---

## 7. Failure Taxonomy (16 Canonical Tags)

Tagged on every failed candidate and stored in telemetry / `generation_runs` for Phase 9 model fine-tuning:

1. `GENERIC`
2. `TOO_LONG`
3. `TOO_SHORT`
4. `REPETITIVE`
5. `OBVIOUS_AI`
6. `LOW_RELEVANCE`
7. `NO_NEW_VALUE`
8. `UNSUPPORTED_CLAIM`
9. `FORCED_QUESTION`
10. `TOO_PROMOTIONAL`
11. `TOO_AGREEABLE`
12. `OVERLY_FORMAL`
13. `OFF_TOPIC`
14. `WEAK_HOOK`
15. `COPIED_STRUCTURE`
16. `LOW_CONVERSATIONAL_VALUE`

---

## 8. Regeneration Loop & Human Review Queue

If all 3 generated candidates fail the evaluation gate:
1. **Regeneration Pass**: Collects all unique failure tags and feeds them back into Stage 2 prompt context (`Avoid prior failure modes: GENERIC, FORCED_QUESTION...`).
2. **Human Review Queue**: If the regenerated candidates also fail, the top candidate is routed to `chrome.storage.local.humanReviewQueue` (up to 50 items) for human inspection (Phase 11), ensuring bad replies are not auto-posted.

---

## 9. Verification & Test Suite

```bash
npm test
```

### Coverage Summary:
- **`src/tests/evaluator.test.js`**: 25+ comprehensive tests covering taxonomy, weights, thresholds, genericity, forced questions, claims, duplicates, structural repetition, and orchestration.
- **`src/tests/eval.test.js`**: Integration tests against `EVAL_FIXTURES`.
- **Full suite**: 13 suites all green.
