# Orchestrator Deterministic Path Audit

## Goal

Prove that every parser rule in `src/intents/orchestrator/parser.ts` is correct
against the full corpus of 83,624 real messages. Build a ground-truth label for
every message so we can measure precision/recall of each deterministic rule and
identify systematic failures before going to production.

## Why This Matters

The deterministic path handles messages without LLM calls — it's faster, cheaper,
and more predictable. But a single misclassification (false SKIP on a real trade,
or false EXECUTE on commentary) causes real money loss. Every rule must be
verified against real data, not just synthetic fixtures.

## Phases

### Phase 1: Parser Baseline (programmatic)

Run the parser on all 83,624 messages. Collect:
- Hard skip rate and reason distribution
- Action/strategy/direction distribution for non-skip messages
- Complexity flag frequency (what drives LLM escalation)
- Badge-vs-parser agreement (does parser action match badge intent?)
- Edge case samples for manual review

Output: `scratchpad/audit-parser-results.json`

### Phase 2: Agent Labeling (parallel agents)

Spawn agents to create ground-truth labels for messages by category:

| Category | Count (est) | Agent Strategy |
|----------|-------------|----------------|
| Badge: Long only | ~6,794 | OPEN expected — verify symbol/strategy/direction |
| Badge: Short only | ~4,424 | OPEN expected — verify direction=SHORT or sell-to-open |
| Badge: Exit+Long | ~4,511 | CLOSE/TRIM/LEG_OFF expected — verify action |
| Badge: Exit+Short | ~2,629 | CLOSE/TRIM/LEG_OFF expected — verify action |
| Badge: Exit only | ~1,847 | CLOSE expected — verify symbol match |
| Badgeless with symbol | ~TBD | Mostly SKIP — verify no missed trades |
| Badgeless no symbol | ~TBD | All SKIP — verify correct |
| Multi-badge combos | ~200+ | Complex — careful review needed |

Agents write to `message_labels` table with `source = 'audit-agent'`.

### Phase 3: Comparison & Report

- Confusion matrix: parser outcome vs label outcome
- Per-rule precision/recall
- Systematic failure patterns
- Recommendations for parser fixes or new deterministic rules

## Success Criteria

- Every badge message has a ground-truth label
- Parser achieves >99% agreement with labels on badge messages
- All hard-skip rules have 0 false positives (no real trades skipped)
- Complexity flag escalation rate is justified (LLM path is only used when necessary)

## Non-Goals

- We are NOT auditing the LLM path's quality here
- We are NOT auditing open-path or position-path resolution (strike selection, expiry)
- We are NOT changing the parser in this audit — only measuring it
