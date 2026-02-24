---
description: Investigate a misclassified trade exit signal — root cause it and add eval cases (single agent)
user_invocable: true
---

A trade exit signal was misclassified (e.g., labeled as auto-close when a trader actually posted an exit, or vice versa). Investigate and fix it.

## Steps

1. **Identify the trade**: From the context below, find the trade ID, message ID, and relevant signals in the database.
2. **Trace the signal path**: Follow the pipeline — message → intent extraction → signal → execute — to find where the classification went wrong. Key files:
   - `src/intents/extract-intent.ts` (intent prompt + version)
   - `src/intents/postprocess.ts` (signal postprocessing)
   - `src/pipeline/execute.ts` (signal execution)
   - `src/lib/skip-position-alert.ts` (skip logic)
3. **Root cause**: Was it a prompt gap, a postprocessing bug, a matching failure, or a pipeline issue? Query the DB (`message_intents`, `trade_events`, `trades`, `messages`) to confirm what actually happened vs what should have happened.
4. **Fix**: If it's a prompt/extraction issue, update the prompt or postprocessing. If it's a pipeline issue, fix the code.
5. **Add eval cases**: Add fixture(s) to `src/intents/evals/fixtures/` covering this scenario. Follow the existing fixture format in that directory.
6. **Verify**: Run `npx tsx scripts/eval-intents.ts` and confirm the new cases pass.

## Context

$ARGUMENTS
