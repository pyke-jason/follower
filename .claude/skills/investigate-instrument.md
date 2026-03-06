---
description: Investigate a trade where the instrument was misclassified (e.g., extracted as NAKED_CALL when it should be stock LONG/SHORT, or vice versa) — root cause it and add eval cases (single agent)
user_invocable: true
---

A trade signal had the wrong instrument type — for example, the orchestrator produced a NAKED_CALL/NAKED_PUT when the trader meant a stock position (LONG/SHORT equity), or produced a stock trade when they meant options. Investigate and fix it.

## Steps

1. **Identify the trade**: From the context below, find the trade ID, message ID, and relevant signals in the database. Query `messages` for the raw text (`clean_text`, `badges`), `run_decisions` for what the orchestrator decided, and `trades`/`trade_events` for what was executed.

2. **Understand the message**: Determine what the trader actually meant — stock trade or options trade? Key signals:
   - "Bought/sold [ticker] shares/stock" → stock trade (LONG or SHORT equity, no legs)
   - "Long [ticker]" with no strike/expiry/strategy context → likely stock, not a call
   - "[ticker] 450c 3/21" or "calls/puts" with strikes → options
   - Direction/strategy rules from `CLAUDE.md` coding standards and `.claude/rules/orchestrator.md` apply

3. **Trace the orchestrator**: Instrument type is determined by the **parser** (`orchestrator/parser.ts`) using deterministic rules — badges, keywords, strike patterns. The parser is sync with zero I/O.
   - Check if the parser's strategy detection (CDS/PDS/PCS/CALL/PUT/STOCK) matches the message
   - Check if complexity flags incorrectly sent it to `llm-path.ts`
   - If it went to LLM path, check if the agent misclassified the instrument

4. **Root cause**: Was it a parser pattern gap (missing regex for this message pattern), a badge misinterpretation, or an LLM hallucination? Query the DB to confirm what was produced vs what should have been.

5. **Fix**: If it's a parser issue, add/fix patterns in `parser.ts`. If it's an LLM prompt gap, update `llm-path.ts`. Instrument classification should be deterministic whenever possible — prefer parser fixes over LLM fixes.

6. **Add eval cases**: Add fixture(s) to `src/intents/evals/fixtures/` covering this scenario. Follow the existing fixture format (see `.claude/rules/intent-evals.md`).

7. **Verify**: Run `npx tsx scripts/eval-orchestrator.ts` and confirm the new cases pass.

## Context

$ARGUMENTS
