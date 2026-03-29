---
paths: src/intents/**
---

# Orchestrator & Intent Resolution

## Architecture

The orchestrator (`index.ts`) routes messages through a decision tree. Each step either returns a result or falls through to the next.

```
Message -> parser.ts (sync, zero I/O) -> index.ts routing:
  1. Hard skip -> SKIP (paper trades, futures, expired worthless, blacklisted symbols)
  2. Strangle exit (action != OPEN on strangle) -> close all matching positions
  3. Strangle open -> fork into CALL + PUT OPEN signals via open-path
  4. STOCK OPEN->ADD reroute (orchestrator checks DB for existing position)
  5. Deterministic ADD -> open-path.ts (match existing position, resolve as OPEN)
  6. Deterministic OPEN -> open-path.ts (market data only)
     - If open-path returns MANUAL_REVIEW -> falls through to LLM
  7. Deterministic CLOSE/TRIM/LEG_OFF -> position-path.ts (DB positions only)
     - If position-path returns MANUAL_REVIEW -> falls through to LLM
  8. LLM path -> llm-path.ts (NLU for anything unresolved)
```

Steps 5-7 are gated by `needsLLM` — skipped entirely when complexity flags are set, action is null, or failureContext is present.

## Parser (parser.ts) -- Pure & Sync

The parser is **synchronous with zero I/O**. It detects strategy, direction, strike hints, action, complexity flags, and special markers (lotto, strangle). No database queries, no API calls, no async.

Complexity flags trigger the LLM path. If you can handle a case deterministically, add it to the parser -- it is faster, cheaper, and more testable than LLM.

Current complexity flags (see `ComplexityFlag` type in `types.ts`):
- `extra_text` -- significant commentary beyond core trade fields
- `multi_ticker` -- more than one ticker detected
- `relational` -- references another trader's message
- `mixed_action` -- entry + exit in same message
- `ambiguous_strikes` -- slash pair could be date or strikes
- `no_badge_exit` -- exit verb detected without Exit badge
- `ambiguous_strategy` -- badge implies STOCK but no confirmation

## open-path.ts vs position-path.ts

- `open-path.ts`: Resolves OPEN and ADD signals. Needs market data (expiry dates, option chains, quotes). Also handles `resolveAddPath()` which matches an existing position then resolves the add.
- `position-path.ts`: Resolves CLOSE/TRIM/LEG_OFF. Needs DB positions (fuzzy match existing) but not option chains.

Keep these concerns separate. Do not add position lookups to open-path or chain lookups to position-path. The one exception is the STOCK OPEN->ADD reroute in `index.ts`, which checks positions before delegating to `resolveAddPath()`.

## intent-cache.ts

Records ALL orchestrator decisions (deterministic and LLM) in the `message_intents` table. LLM results are cached and reused on cache hit to skip the expensive agent loop. Bump `INTENT_VERSION` when changing `NLU_SYSTEM_PROMPT`, tool schemas, parser logic, or prompt construction -- this invalidates all cached results.

## LLM Path (llm-path.ts)

Used when the parser sets complexity flags, cannot determine the action, or a deterministic path returns MANUAL_REVIEW. Runs an agent loop with `submit_decision` tool. Costs API tokens -- prefer deterministic paths when possible.

Also handles 422 retry (invalid strike from deterministic resolution). When `failureContext` is present, the prompt includes the failure error so the LLM can correct the strike. Cache is skipped for 422 retries.

## Event Emissions

The orchestrator emits two event types:
- `PARSED` -- always, for every message (includes route: `hard-skip` | `deterministic` | `llm`)
- `SIGNAL_RESOLVED` -- per signal, only for EXECUTE outcomes

`SETTLED` is emitted by the caller (`process-task.ts` for live, `runner.ts` for backtest), never by the orchestrator. These events drive the `run_decisions` table. Do not skip event emissions -- the backtest detail page depends on them.

## Types (types.ts)

`ResolvedSignal`, `ParseResult`, `OrchestratorResult`, `OrchestratorContext` are the key contracts. When adding fields to these types, consider that both backtest and live consume them. `SerializedParseResult` is the JSON-safe subset of `ParseResult` (complexityFlags as array, minus internal-only fields).

## Direction Semantics

The parser's `direction` field (LONG/SHORT) means whether the trader is BUYING or SELLING the instrument. It does NOT represent their bullish/bearish stock view.

**For STOCK, CALL, PUT** -- direction is meaningful and used by open-path:
- "Short [ticker] puts/calls" = bearish/bullish VIEW, but BUYING options -> direction: LONG.
- "Sold [ticker] puts" = SELLING puts for premium -> direction: SHORT. "Sold" is authoritative.
- "Lotto"/"Yolo" = speculative BUY, always direction: LONG, never sell-to-open.
- "Bought"/"Sold" in the message are authoritative -- they override any Long/Short prefix badge.

**For spreads (CDS, PDS, PCS, CCS)** -- direction is derived from leg structure, not the direction field. `buildSpreadOptionLegs()` in open-path maps strategy to leg sides deterministically. `isCreditStrategy()` handles credit/debit pricing. The parser sets `directionFromStrategy` to LONG for CDS and PDS, but leaves it null for PCS (no CCS regex exists -- see Known Parser Gaps). This is safe because spread execution uses `buildSpreadOptionLegs()`, never the direction field.

## Known Parser Gaps

CCS (Call Credit Spread) has no detection regex in the parser. Messages containing "call credit spread" or "CCS" without additional deterministic markers will fall to the LLM path.