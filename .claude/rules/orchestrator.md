---
paths: src/intents/**
---

# Orchestrator & Intent Resolution

## Architecture

The orchestrator routes messages through a decision tree:

```
Message -> parser.ts (sync, zero I/O) -> routing decision:
  1. Hard skip (paper trades, futures, expired worthless, etc.)
  2. Strangle exit (CLOSE/TRIM on strangle) -> close all matching positions
  3. Strangle open -> fork into CALL + PUT OPEN signals via open-path
  4. Deterministic: ADD -> open-path.ts (match existing position, then resolve as OPEN)
  5. Deterministic: OPEN -> open-path.ts (market data only)
  6. Deterministic: CLOSE/TRIM/LEG_OFF -> position-path.ts (DB only)
  7. LLM path -> llm-path.ts (NLU for ambiguous messages)
```

## Parser (parser.ts) — Pure & Sync

The parser is **synchronous with zero I/O**. It detects strategy, direction, strike hints, action, and complexity flags. No database queries, no API calls, no async.

Complexity flags trigger the LLM path. If you can handle a case deterministically, add it to the parser — it's faster and cheaper than LLM.

## open-path.ts vs position-path.ts

- `open-path.ts`: Resolves OPEN signals. Needs market data (expiry dates, option chains, quotes) but not DB positions.
- `position-path.ts`: Resolves CLOSE/TRIM/LEG_OFF. Needs DB positions (fuzzy match existing) but not option chains.

Keep these concerns separate. Don't add position lookups to open-path or chain lookups to position-path.

## LLM Path (llm-path.ts)

Used when the parser sets complexity flags or can't determine the action. Runs an agent loop with `submit_decision` tool. Costs API tokens — prefer deterministic paths when possible.

The LLM path also handles 422 retry (invalid strike from parser). When `failureContext` is present, the prompt includes the failed symbol so the LLM can correct the strike.

## Event Emissions

The orchestrator emits `PARSED` (always) and `SIGNAL_RESOLVED` (per signal, for EXECUTE outcomes). `SETTLED` is emitted by the caller (runner), not the orchestrator. These events drive the `run_decisions` table. Don't skip event emissions — the backtest detail page depends on them.

## Types (types.ts)

`ResolvedSignal`, `ParseResult`, `OrchestratorResult`, `OrchestratorContext` are the key contracts. When adding fields to these types, consider that both backtest and live consume them.

## Direction Semantics

The `direction` field (LONG/SHORT) means whether the trader is BUYING or SELLING the instrument. It does NOT represent their bullish/bearish stock view. Key mappings:

- "Short [ticker] puts/calls" = bearish/bullish VIEW, but BUYING options → direction: LONG.
- "Sold [ticker] puts" = SELLING puts for premium (bullish) → direction: SHORT. "Sold" is authoritative.
- "Long [ticker] pcs 68/67 for credit" = bullish VIEW, SELLING a put credit spread → direction: SHORT, strategy: PDS.
- Debit strategies (CDS, PDS bought, naked long options) = always direction: LONG.
- Credit strategies (PCS, sold/written options) = always direction: SHORT.
- "Lotto"/"Yolo" = speculative BUY, always direction: LONG, never sell-to-open.
- "Bought"/"Sold" in the message are authoritative — they override any Long/Short prefix badge.
