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

The parser is **synchronous with zero I/O**. It uses ONLY structural metadata from the Discord envelope:
- `message.badges` — `Long` / `Short` / `Exit` drive action + direction.
- `message.symbols[0]` — the cashtag-extracted ticker.

For field-level content (strategy, strikes, expiry, statedPrice), the parser ONLY populates fields when the entire message matches a **whole-message canonical template** in `canonical-trade.ts`. Anything else stays null and the LLM handles it.

### Whole-message templates only — no prose keyword scanning

**Banned pattern**: "message contains the word PDS → strategy = PDS". A long sentence that mentions `PDS` does not mean the trader is doing a PDS trade — the whole message might be commentary like "these PDSes look good today". Populating Signal fields from keyword presence produces false positives on commentary and over-specifies labels.

**Required pattern**: the regex must describe the ENTIRE meaningful content after stripping badge + symbol + trivial modifiers (parens, P&L annotations like "for $5 gain", size notes like "spec size"). If any residue remains that the template didn't account for, don't match.

Canonical templates we support (see `canonical-trade.ts` for the exact regexes):

| Text shape | Extracts |
|---|---|
| `Long NVDA 182.38` / `Short VRT $260.76` | STOCK + price |
| `Short VXX @ 34.20` / `Short SHOO at $32.03` | STOCK + price |
| `Long NVDA 175c 12/21` | CALL strike + MM/DD expiry |
| `Long NVDA 175c 9/26 2.03` / `… @ 2.03` / `… for 2.03` | CALL + strike + expiry + price |
| `Long AMD 155p 10/3 @ 2.10` | PUT equivalent |
| `Long UNH cds 330/340 for $0.52 [credit\|debit]` | CDS/PDS/PCS/CCS spread + strikes + price |

Ambiguity is allowed in the output schema. `"Long NVDA"` alone returns null — we don't know if it was stock, a call, or a spread — and the LLM decides. The label schema permits `strategy: null` for that reason.

### Hard skips from structural data only

- Non-trade badge present without a trade badge (Annotation, Note, etc.) → SKIP.
- No symbol AND no trade action → SKIP (pure commentary with no ticker).

Paper-trade, futures, strangle, lotto, spread-acronym, and symbol-blacklist keyword scans have been removed. If a paper trade or futures ticker needs to hard-skip, the LLM returns SKIP with a reason.

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

Anything not matching a canonical template falls to the LLM. Common unsupported shapes:
- Bare ticker (`"Long NVDA"`) — strategy genuinely ambiguous without more context.
- Rolls (`"rolled my $32 put to next week"`) — multi-step transactions.
- Setup announcements (`"UNHLong calls 337s vs 340s will start taking pts"`) — future intent, not a trade yet.
- Context-dependent exits (`"TSLA adding"`, `"same with OPEN"`) — needs prior-message context.

If you find yourself wanting to add a prose keyword scan ("if the message contains X, set field Y"), stop and reconsider: is the entire message structure canonical, or are you fishing for a token in commentary? If the latter, the LLM owns it.