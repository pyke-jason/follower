---
description: Investigate a misclassified trade exit signal — root cause it and add eval cases (single agent)
user_invocable: true
---

A trade exit signal was misclassified (e.g., labeled as auto-close when a trader actually posted an exit, or vice versa). Investigate and fix it.

## Steps

1. **Identify the trade**: From the context below, find the trade ID, message ID, and relevant signals in the database. Query `messages`, `trades`, `trade_events`, and `run_decisions`.

2. **Trace the signal path**: The pipeline is: message → `orchestrator/parser.ts` (sync, zero I/O) → routing in `orchestrator/index.ts` → resolve path → `execute-resolved.ts`. For exits specifically:
   - Parser detects action (CLOSE/TRIM/LEG_OFF) and complexity flags
   - If deterministic → `position-path.ts` (fuzzy-matches DB positions)
   - If ambiguous → `llm-path.ts` (NLU agent loop)
   - Skip logic: `src/lib/skip-position-alert.ts`
   Find where in this chain the classification went wrong.

3. **Root cause**: Was it a parser pattern gap (e.g., missing regex for an exit phrase), a position-matching failure in position-path, an LLM misclassification, or a pipeline issue? Query the DB to confirm what actually happened vs what should have happened.

4. **Fix**: If it's a parser issue, add/fix patterns. If it's a position-path matching bug, fix the matcher. If it's an LLM prompt gap, update `llm-path.ts`.

5. **Add eval cases**: Add fixture(s) to `src/intents/evals/fixtures/` covering this scenario. Follow the existing fixture format (see `.claude/rules/intent-evals.md`).

6. **Verify**: Run `npx tsx scripts/eval-orchestrator.ts` and confirm the new cases pass.

## Context

$ARGUMENTS
