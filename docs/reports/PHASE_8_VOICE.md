# PHASE 8 — Voice Profiling
## ReplyGenie Chrome Extension

**Completed:** 2026-08-28  
**Tests:** 15 suites passing (all green)  
**Syntax check:** All files pass `node --check`  
**Core principle:** High-fidelity stylistic signal extraction without hallucinated personality tropes or smoothing toward generic grammar.

---

## 1. Architecture Overview

```
Historical Replies (IndexedDB) + Manual Rejections (Storage)
       │
       ▼
VoiceProfiler (`src/background/profiler.js`)
       │
       ├─► 1. Observable Feature Extraction
       │     ├─ Sentence / word / character lengths
       │     ├─ Punctuation patterns (!, ?, ..., —, ;, trailing periods)
       │     ├─ Vocabulary, technical jargon density, & n-grams
       │     ├─ Directness (absence of hedging) & Dominant Tone
       │     └─ Formatting (lowercase starts, fragments, line breaks)
       │
       ├─► 2. Performance-Class Weighting Multipliers
       │     ├─ OUTSTANDING: 5.0x
       │     ├─ MODERATE:    2.0x
       │     ├─ BASELINE:    1.0x
       │     └─ NEGATIVE (Rejected / Failed): -1.5x (Suppresses bad traits)
       │
       ├─► 3. Versioned Voice Profile Persistence
       │     └─ Saved to IndexedDB (`voice_profiles`) with incremented version,
       │        `sample_size`, `last_trained_at`, and `is_active = 1`
       │
       ▼
Generation Injection (`formatVoiceProfileForPrompt`)
       └─ Injected into Stage 2 prompt as objective stylistic directives
```

---

## 2. What the Voice Profile Captures

The `VoiceProfiler` strictly encodes **empirically observable writing traits**, avoiding vague or hallucinated personality descriptors.

| Trait Category | Specific Metric | Formula / Source |
|---|---|---|
| **Length & Rhythm** | `avg_length`, `avg_words`, `sentence_length` | Performance-weighted character & word averages |
| **Punctuation Dynamics** | `exclamation`, `question`, `ellipsis`, `em_dash`, `semicolon`, `trailing_periods` | Weighted occurrence frequency per reply |
| **Formatting Quirks** | `lowercase_start`, `bullet_points_used`, `line_break_frequency` | Preserved informal structures without grammatical smoothing |
| **Vocabulary & Jargon** | `frequent_words`, `technical_vocabulary`, `jargon_density`, `unique_word_ratio` | Stopword-filtered tokens matched against domain dictionary |
| **Natural Expressions** | `recurring_expressions` | Non-stopword bigrams and trigrams occurring $\ge 2$ times |
| **Tone & Directness** | `directness`, `tone` | Calculated as $1.0 - \text{hedging\_rate}$; tone derived from observed traits |
| **Behavioral Habits** | `use_of_numbers`, `use_of_personal_experience`, `use_of_examples`, `disagreement_frequency`, `emoji_frequency` | Frequency of citing stats, first-person experiences, and counter-points |

---

## 3. How the Profile Refreshes & Retrains

1. **Automatic Refresh on Manual Posts**:
   When the user publishes a manual post on X, `watchForManualReplies()` captures the text and triggers `learnFromReply()`. This stores the record in IndexedDB (`is_human_written = 1`) and automatically calls `syncVoiceProfileFromDatabase()`.
2. **Periodic / Batch Syncing**:
   `syncVoiceProfileFromDatabase()` reads up to 300 recent classified replies from IndexedDB, retrieves manual rejections from storage, increments the profile `version` counter, sets `is_active = 1`, and persists the updated model to IndexedDB.
3. **Generation Run Lineage**:
   Every intelligent generation logs `voice_profile: "vp_v" + version` in `_promptVersions` and `generation_runs`, allowing exact A/B evaluation of prompt performance across profile versions.

---

## 4. Before & After Sample: Real Writing vs. Generic Tropes

### Scenario: Replying to a post about database migration bottlenecks

#### ❌ Before Voice Profiling (Generic Assistant Tone):
> *"Great insights! Migrating databases is definitely a challenging journey. What would you do differently if you were starting fresh today? Thoughts?"*

**Why this fails:**
- Hollow praise (*"Great insights!"*)
- Cliché corporate buzzwords (*"challenging journey"*)
- Generic boilerplate question (*"What would you do differently..."*)
- Forced engagement bait ending (*"Thoughts?"*)

---

#### ✅ After Voice Profiling (Learned from Real Indie/Engineer Voice):
> *"foreign key checks in sqlite lock the whole db during write bursts — we had to batch inserts into chunks of 500 to keep p99 latency under 20ms"*

**Why this succeeds (Matches Learned Profile):**
- **Lowercase start & fragment rhythm** (`lowercase_start: true`, `trailing_periods: false`)
- **Direct & Empirical** (`directness: 0.92`, `use_of_numbers: 0.50`, cites `500`, `20ms`, `p99`)
- **Domain Vocabulary** (`technical_vocabulary: ["sqlite", "db", "latency", "p99", "inserts"]`)
- **No praise, no forced questions, no sycophancy**

---

## 5. Test Suite Verification

```bash
npm test
```

### Coverage:
- **`src/tests/profiler.test.js`**: 8 comprehensive tests covering text feature extraction, n-gram extraction, performance weighting (5x outstanding vs 1x baseline), negative signal suppression, non-smoothing of informal syntax, version incrementing, and prompt formatting.
- **Full Suite**: 15 test suites, 236 tests all green.
