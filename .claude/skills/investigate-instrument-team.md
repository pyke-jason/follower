---
description: Investigate a trade where the instrument was misclassified (e.g., extracted as NAKED_CALL when it should be stock LONG/SHORT) with a team of agents — root cause, fix, and add eval cases
user_invocable: true
---

A trade signal had the wrong instrument type — for example, the intent extraction produced a NAKED_CALL/NAKED_PUT when the trader meant a stock position (LONG/SHORT equity), or vice versa. Spin up an investigation team to root cause and fix it.

## Team Structure

Spawn an agent team with these roles:

1. **db-investigator** (investigator agent): Query the database to reconstruct what actually happened — find the trade, its events, the source message (`clean_text`, `badges`, `symbols`), and the cached intent (`message_intents`). Compare the extracted `strategy` and `legs` against the raw message text. Produce a clear finding: what was extracted vs what should have been.
2. **code-investigator** (Explore agent): Read the intent prompt (`extract-intent.ts`), postprocessing logic (`postprocess.ts`), and signal schemas to identify why the wrong instrument type was produced. Check: are stock vs options disambiguation rules present? Did postprocessing inject or transform legs? Is there a schema default that forces options when stock was intended?
3. **fixer** (general-purpose agent): Once investigators reach consensus on root cause, implement the fix (prompt rules/examples, postprocessing fix, or schema change) AND add eval fixture(s) to `src/intents/evals/fixtures/`. Bump `INTENT_VERSION` if the prompt changes. Run `npx tsx scripts/eval-intents.ts` to confirm new cases pass.

## Key Files

- `src/intents/extract-intent.ts` — intent prompt + INTENT_VERSION
- `src/intents/postprocess.ts` — signal postprocessing
- `src/intents/prompts.ts` — prompt templates (if used)
- `src/intents/evals/fixtures/` — eval fixture JSON files
- `scripts/eval-intents.ts` — eval runner
- `src/pipeline/execute.ts` — signal execution
- `src/broker/schemas.ts` — signal/leg schemas

## Workflow

1. Launch db-investigator and code-investigator in parallel
2. Wait for both to report findings
3. Synthesize a root cause — they must agree on what went wrong and whether this is a stock-vs-options disambiguation failure
4. Assign the fixer to implement the fix and add eval cases
5. Do not stop until eval cases are added and passing

## Context

$ARGUMENTS
