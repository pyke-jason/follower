---
description: Investigate a trade where the instrument was misclassified (e.g., extracted as NAKED_CALL when it should be stock LONG/SHORT, or vice versa) — root cause it and add eval cases (single agent)
user_invocable: true
---

A trade signal had the wrong instrument type — for example, the intent extraction produced a NAKED_CALL/NAKED_PUT when the trader meant a stock position (LONG/SHORT equity), or produced a stock trade when they meant options. Investigate and fix it.

## Steps

1. **Identify the trade**: From the context below, find the trade ID, message ID, and relevant signals in the database. Query `messages` for the raw text, `message_intents` for the cached extraction, and `trades`/`trade_events` for what was executed.
2. **Understand the message**: Read the raw `clean_text` and `badges` from `messages`. Determine what the trader actually meant — stock trade or options trade? Key signals:
   - "Bought/sold [ticker] shares/stock" → stock trade (LONG or SHORT equity, no legs)
   - "Long [ticker]" with no strike/expiry/strategy context → likely stock, not a call
   - "[ticker] 450c 3/21" or "calls/puts" with strikes → options
   - Direction/strategy rules from `CLAUDE.md` domain_rules apply
3. **Trace the extraction**: Read `src/intents/extract-intent.ts` (the prompt) and `src/intents/postprocess.ts` to understand why the LLM produced the wrong instrument type. Check:
   - Does the prompt have clear rules distinguishing stock vs options?
   - Did postprocessing transform a correct extraction into the wrong type?
   - Did the LLM hallucinate legs/strikes that weren't in the message?
4. **Root cause**: Was it a prompt gap (no rule for this pattern), a postprocessing bug, or an LLM hallucination? Query the DB to confirm what was extracted vs what should have been.
5. **Fix**: If it's a prompt issue, add rules/examples to the intent prompt. If it's postprocessing, fix the code. Bump `INTENT_VERSION` if the prompt changes.
6. **Add eval cases**: Add fixture(s) to `src/intents/evals/fixtures/` covering this scenario. Follow the existing fixture format.
7. **Verify**: Run `npx tsx scripts/eval-intents.ts` and confirm the new cases pass.

## Context

$ARGUMENTS
