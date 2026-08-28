# PHASE 10 — Analytics Dashboard Data Layer
## ReplyGenie Chrome Extension

**Completed:** 2026-08-28  
**Tests:** 17 suites passing (all green)  
**Syntax check:** All files pass `node --check`  
**Core principle:** High-fidelity metrics aggregation across generation mix, impression distribution, rejection rates, top/worst rankings, and Qualified Conversation Rate (QCR).

---

## 1. Metric Definitions & Formulas

| Category | Metric Key | Definition / Formula | Query Target |
|---|---|---|---|
| **Generation Mix** | `total_replies` | Total count of stored replies in database | `generation_mix.total_replies` |
| | `database_reuse_rate` | $\frac{\text{reused\_replies}}{\text{total\_replies}}$ (`is_reused = 1`) | `generation_mix.database_reuse_rate` |
| | `database_adaptation_rate` | $\frac{\text{adapted\_replies}}{\text{total\_replies}}$ (`is_adapted = 1`) | `generation_mix.database_adaptation_rate` |
| | `ai_generation_rate` | $\frac{\text{ai\_generated\_replies}}{\text{total\_replies}}$ (`is_ai_generated = 1`) | `generation_mix.ai_generation_rate` |
| | `human_written_rate` | $\frac{\text{human\_written\_replies}}{\text{total\_replies}}$ (`is_human_written = 1`) | `generation_mix.human_written_rate` |
| **Impressions** | `average` | Arithmetic mean of impressions across all replies | `impressions.average` |
| | `median` | 50th percentile of sorted impressions | `impressions.median` |
| | `outstanding_count` | Replies where `performance_class === 'outstanding'` | `impressions.outstanding_count` |
| | `moderate_count` | Replies where `performance_class === 'moderate'` | `impressions.moderate_count` |
| | `baseline_count` | Replies where `performance_class === 'baseline'` | `impressions.baseline_count` |
| **Engagement** | `average_engagement_rate` | $\frac{\text{likes} + \text{replies} + \text{reposts} + \text{bookmarks}}{\text{total\_impressions}}$ | `engagement.average_engagement_rate` |
| | `author_reply_rate` | $\frac{\text{replies with author response}}{\text{total\_replies}}$ | `engagement.author_reply_rate` |
| | `profile_visit_rate` | $\frac{\text{profile\_visits}}{\text{total\_impressions}}$ | `engagement.profile_visit_rate` |
| **Behavioral** | `question_rate` | $\frac{\text{replies containing '?'}}{\text{total\_replies}}$ | `behavioral.question_rate` |
| **Quality Gate** | `genericity_rejection_rate` | $\frac{\text{GENERIC rejections}}{\text{total evaluated samples}}$ | `quality_gate.genericity_rejection_rate` |
| | `accuracy_rejection_rate` | $\frac{\text{UNSUPPORTED\_CLAIM rejections}}{\text{total evaluated samples}}$ | `quality_gate.accuracy_rejection_rate` |
| | `duplicate_rejection_rate` | $\frac{\text{REPETITIVE rejections}}{\text{total evaluated samples}}$ | `quality_gate.duplicate_rejection_rate` |
| **Rankings** | `top_20_replies` | Top 20 replies sorted by `performance_score` / `impressions` | `rankings.top_20_replies` |
| | `worst_20_replies` | Bottom 20 replies sorted by `performance_score` ascending | `rankings.worst_20_replies` |
| | `top_20_patterns` | Top 20 mined patterns from `replyPatternsRepo` | `rankings.top_20_patterns` |
| | `top_strategies` / `worst_strategies` | Strategies ranked by average performance score | `rankings.top_strategies` |
| | `top_topics` / `worst_topics` | Topics ranked by average performance score | `rankings.top_topics` |

---

## 2. Qualified Conversation Rate (QCR)

### Why Raw Impressions Are Insufficient
A reply under a mega-viral tweet can accumulate 50,000 impressions purely from feed volume without sparking any genuine interest or connection. Treating impressions alone as success biases the system toward superficial engagement farming.

### Formula
$$\text{QCR} = \frac{\text{author\_replies} + \text{meaningful\_user\_replies} + \text{profile\_visits} + \text{attributable\_follows}}{\text{reply\_impressions}}$$

### Query Location:
```json
{
  "qualified_conversation": {
    "qualified_conversation_rate": 0.0059,
    "total_qualified_events": 86,
    "author_replies": 2,
    "meaningful_user_replies": 13,
    "profile_visits": 62,
    "attributable_follows": 9,
    "formula": "(author_replies + meaningful_user_replies + profile_visits + attributable_follows) / total_impressions"
  }
}
```

---

## 3. How to Query the Analytics API

The analytics data layer is accessible via Chrome runtime messaging:

```javascript
// One-shot query from options, popup, or test suite:
chrome.runtime.sendMessage({ type: "GET_ANALYTICS_DASHBOARD" }, (response) => {
  if (response.ok) {
    const { metrics, rankings } = response.data;
    console.log("QCR:", metrics.qualified_conversation.qualified_conversation_rate);
    console.log("Top Strategy:", rankings.top_strategies[0]);
  }
});
```

---

## 4. Test Suite Verification

```bash
npm test
```

### Coverage:
- **`src/tests/analytics.test.js`**: 9 unit tests verifying statistical calculations, generation mix percentages, impression percentiles, engagement and author reply rates, behavioral question tracking, rejection rates by failure category, QCR calculations, and top/worst ranking sort invariants.
- **Full Suite**: 17 test suites, 257 tests all green.
