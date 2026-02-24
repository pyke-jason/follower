---
description: Investigate a misclassified trade exit signal with a team of agents — root cause, fix, and add eval cases
user_invocable: true
---

A trade exit signal was misclassified (e.g., labeled as auto-close when a trader actually posted an exit, or vice versa). Spin up an investigation team to root cause and fix it.

## Team Structure

Spawn an agent team with these roles:

1. **db-investigator** (investigator agent): Query the database to reconstruct what actually happened — find the trade, its events, the source message, the cached intent, and the close/sweep path. Produce a timeline of events.
2. **code-investigator** (Explore agent): Trace the code path that led to the misclassification. Read the intent prompt, postprocessing logic, execute pipeline, and skip logic. Identify the exact point where the wrong decision was made.
3. **fixer** (general-purpose agent): Once investigators reach consensus on root cause, implement the fix (prompt update, code change, or both) AND add eval fixture(s) to `src/intents/evals/fixtures/`. Run `npx tsx scripts/eval-intents.ts` to confirm new cases pass.

## Key Files

- `src/intents/extract-intent.ts` — intent prompt + INTENT_VERSION
- `src/intents/postprocess.ts` — signal postprocessing
- `src/intents/evals/fixtures/` — eval fixture JSON files
- `scripts/eval-intents.ts` — eval runner
- `src/pipeline/execute.ts` — signal execution
- `src/lib/skip-position-alert.ts` — skip logic

## Workflow

1. Launch db-investigator and code-investigator in parallel
2. Wait for both to report findings
3. Synthesize a root cause from their findings — they must agree on what went wrong
4. Assign the fixer to implement the fix and add eval cases
5. Do not stop until eval cases are added and passing

## Context

$ARGUMENTS
