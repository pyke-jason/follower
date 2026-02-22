# Backend Architecture Review — Consensus Report
Date: 2026-02-22

## Review Process

10 specialist agents independently reviewed the backend codebase, each covering a distinct area:
Signal Pipeline, Broker Layer, Backtest Engine, Data Layer, Agent/LLM Layer, Shared Libraries,
Ingestion/Parsing, Reconciliation/Tasks, API Layer, and Cross-Cutting Concerns.

Their findings were then cross-examined by 3 deliberation agents:
- A Devil's Advocate (calibrating for the internal-tool context, filtering enterprise cargo-cult)
- A Financial Risk Assessor (ranking issues by real-money danger)
- An Architecture Pattern Assessor (identifying systemic strengths and weaknesses)

This document is the synthesized consensus.

---

## Overall Assessment

The backend is architecturally sound for a solo-developer internal trading tool. The core signal
pipeline (extract intent -> classify -> risk check -> execute -> record) is well-designed with
genuine separation of concerns via `PipelineDeps`. Financial calculations have single sources of
truth. Boundary validation via Zod is well-applied at external interfaces.

The main categories of debt are:
1. Financial safety gaps (missing validation on critical write paths)
2. Internal boundary trust (Zod at external boundaries but raw casts internally)
3. Naming/navigability issues (two "trade-agent" files)
4. Configuration scatter (14+ sources, no central registry)

Many issues raised by specialist reviewers are enterprise patterns that do not apply to a
localhost-only single-user tool (auth, structured logging, DI containers, module restructuring).
These were filtered out in the consensus.

---

## CONSENSUS: Top Financial Safety Issues (Fix These)

These are the issues the entire panel agreed are dangerous, ranked by real-money risk.

### 1. CATASTROPHIC: exitPrice defaults to 0 on missing filledPrice

File: src/local-api/routes/trades.ts:38
Also: src/trades/record-trade.ts:167

```typescript
exitPrice: orderResult.filledPrice ?? 0,
```

If a MARKET order does not return a filled price (timeout, network error), the trade is recorded
as closed at $0. This produces catastrophic fake PnL, corrupts risk limit calculations, and can
lock out all subsequent trading. Both the force-exit endpoint AND recordTrade() itself have this
fallback.

Fix: Throw if filledPrice is missing. Never record a close at $0.

### 2. HIGH: recordTrade() has no transaction wrapping

File: src/trades/record-trade.ts:137-204

The trades table write, trade_events emit, and final SELECT are sequential without a transaction.
A crash between them creates permanent divergence between the "source of truth" (trade_events)
and the denormalized view (trades). A transaction also prevents the race where two concurrent
CLOSE signals find the same OPEN trade.

Fix: Wrap each action branch in `db.transaction()`.

### 3. HIGH: SignalR message callback casts unknown to typed without validation

File: src/ingestion/signalr.ts:17-18

```typescript
handler(raw as SignalRMessage);
```

This is the entry point for ALL live trade signals. If OneOption changes their payload shape,
every signal is silently misclassified. The message watchdog only alerts on silence, not on
malformed messages that still arrive.

Fix: Add a single Zod parse call. Highest-ROI fix in the codebase.

### 4. HIGH: placeOrder timeout leaves broker state unknown

File: src/broker/tradestation.ts:106-122

When placeOrder times out, it throws. But the broker may have filled the order. The caller treats
the throw as "order failed" and does not record the trade. A real position exists at the broker
with no DB record.

Existing mitigation: fill-sweep.ts catches orders with brokerOrderId. But if recordTrade never
ran (because placeOrder threw before it), there is no brokerOrderId to sweep.

Fix: Document that reconciliation is the safety net. Consider returning a structured
`{ status: 'TIMEOUT', brokerOrderId?: string }` instead of throwing.

### 5. HIGH: Silent defaults mask broken data

File: src/trades/record-trade.ts:123-124

```typescript
direction: direction ?? 'LONG',
strategy: strategy ?? 'STOCK',
```

If any caller omits direction/strategy, the trade silently records as LONG STOCK. For an options
trade this means contractMultiplier is 1 instead of 100, making PnL 100x too small. Risk limits
become meaningless.

Fix: Make direction and strategy required (throw if missing).

### 6. HIGH: No timeout on LLM agent loop

File: src/agent/agent-loop.ts:62-172

The agent loop has maxTurns but no absolute timeout. A hung LLM API call blocks all signal
processing. Exit signals are queued but never executed. Positions stay open accumulating losses.

Existing mitigation: stale task recovery after 5 minutes. But 5 minutes of missed exits in a
fast market is significant.

Fix: Add AbortSignal-based timeout to the agent loop.

### 7. MEDIUM: Daily balance capture uses UTC instead of ET

File: src/reconciliation/daily-balance.ts:14

```typescript
const today = new Date().toISOString().split('T')[0];
```

During the 5-hour UTC/ET offset window, this captures the wrong trading day's balance. The
drawdown risk check computes against the wrong baseline.

Fix: Use `toDateKeyET()` from `src/lib/et-date.ts` (which already exists for this purpose).

### 8. MEDIUM: Silent LLM parse failure drops trade signals

File: src/agent/trade-agent.ts:216-218

When the LLM submits a malformed decision, safeParse fails and returns null silently. The signal
is dropped with no error, no alert, no fallback to MANUAL_REVIEW.

Fix: Log parse failures. Consider fallback to MANUAL_REVIEW on parse error.

### 9. MEDIUM: getDayOfWeekET() uses local timezone constructor

File: src/lib/et-date.ts:43-45

```typescript
return new Date(year, month - 1, day).getDay();
```

`new Date(year, month-1, day)` uses the system timezone. On a non-ET server, `isTradingDay()`
returns wrong results.

Fix: Use `new Date(Date.UTC(year, month - 1, day)).getUTCDay()`.

### 10. MEDIUM: Stale quotes used for backtest fills (up to 5 days old)

File: src/backtest/market-data.ts:121-189

When current-day quotes are missing, SimBroker walks back up to 5 trading days and fills at
stale prices. A stock that gapped 20% fills at the pre-gap price.

Fix: Throw by default. Add opt-in `allowStaleQuotes` flag for intentional use.

---

## CONSENSUS: Systemic Architectural Strengths (Preserve These)

The panel unanimously agreed these patterns are well-applied and should not be changed:

1. **Single source of truth for financial math**: computeTradePnl(), contractMultiplier(),
   recordTrade(), computeCoreStats() are each defined once and used everywhere.

2. **PipelineDeps dependency injection**: The same deterministic pipeline runs with different
   broker/risk/recording implementations for live vs backtest. This is the architectural backbone.

3. **Composable Drizzle query fragments** (trades/filters.ts): isOpen, forSymbol, forTrader etc.
   Used consistently across live, backtest, and web. Imports from db/schema (not db/client) so
   the web layer can use them.

4. **Boundary validation via Zod with cross-field refinements**: OrderParamsSchema,
   OrderResultSchema, SignalSchema all use .refine() at entry points. The pattern is right.

5. **DST-aware date/time handling**: et-date.ts uses Intl.DateTimeFormat with America/New_York.
   dayBoundsUTC() dynamically computes EST/EDT offsets. No hardcoded UTC offsets.

6. **Resilient external API integration**: src/lib/resilient.ts provides parameterized retry with
   backoff, jitter, error classification, and AbortSignal timeout. placeOrder correctly does NOT
   retry (unknown broker state).

---

## CONSENSUS: Structural Changes Worth Making

These 5 changes fix the most issues per unit of effort. Ordered by impact.

### 1. Wrap recordTrade() action paths in SQLite transactions
Fixes: data corruption risk (#2 above), position lookup race, trades/events divergence.
Complexity: Moderate. ~80-120 lines in one file.
Risk: Low. Test with existing backtest before/after.

### 2. Add Zod validation on internal boundaries (SignalR, JSON column reads, LLM outputs)
Fixes: silent data corruption (#3, #8 above), unvalidated JSON columns, safeParse silent failure.
Complexity: Moderate. ~15-20 call sites.
Risk: Low-moderate. Scan existing DB rows for JSON integrity first.

### 3. Consolidate system prompts into shared classification knowledge
Fixes: intent extraction / live classification drift, duplicate strategy rules.
Complexity: Moderate. Extract common prompt sections into src/agent/classification-knowledge.ts.
Risk: Low. LLM sees same text. Verify with eval suite.

### 4. Rename the dual "trade agent" files
Fixes: naming confusion flagged independently by 4/10 reviewers.
- src/agent/trade-agent.ts -> src/agent/signal-classifier.ts (or run-agent.ts)
- src/trading/trade-agent.ts -> stays (already has clear class name RuleBasedTradeAgent)
Complexity: Trivial. Rename + ~10 import updates. TypeScript catches missed imports.
Risk: Near zero.

### 5. Fix the 10 financial safety issues above
Fixes: the highest-severity items identified by the financial risk assessor.
Complexity: Each is individually small (1-10 lines). Total: moderate.
Risk: Low per item.

---

## CONSENSUS: Things NOT Worth Changing

The devil's advocate and architecture assessor agreed these suggestions from specialist reviews
are overblown for a solo-developer localhost tool:

- **Authentication on localhost API**: CORS is locked to localhost:3000. No internet exposure. Auth
  adds ceremony for zero security gain.

- **Structured JSON logging with correlation IDs**: Console output is read by one person in a
  terminal. The 17 files using console.log are startup scripts, migrations, and diagnostics.

- **Path traversal in logs route**: Log IDs are UUIDs generated by the frontend. No external user
  can craft malicious paths. The risk is theoretical.

- **Split OrderManager into 3 classes**: It is 175 lines. The SRP split adds indirection for no
  behavioral improvement.

- **TokenManager class with mutex**: Node.js is single-threaded. At worst, two concurrent calls
  both refresh the token and the second wins. Not worth a class.

- **PARTIALLY_FILLED order status**: TradeStation does not send partial fills for the order sizes
  this tool uses. Speculative feature for a scenario that does not occur.

- **Central AppConfig object**: The current approach (secrets in env, trader config in DB, constants
  in code) is the standard pattern for this scale. A God config object imports from everywhere.

- **Module restructuring into signal-processing/ folder**: The current layout matches CLAUDE.md
  documentation. Restructuring moves files without fixing behavior.

- **JSDoc on all public exports**: TypeScript types ARE the documentation. CLAUDE.md covers the
  high-level contracts. JSDoc decays faster than it is written.

- **MessageSource interface for ingestion abstraction**: There is one data source. YAGNI.

---

## Summary: What to Do Next

Priority 1 (financial safety, do now):
- Fix exitPrice ?? 0 fallback (throw instead)
- Wrap recordTrade() in transactions
- Add Zod parse to SignalR callback
- Fix daily-balance.ts to use toDateKeyET()
- Fix getDayOfWeekET() UTC constructor bug
- Make direction/strategy required in recordTrade (remove silent defaults)
- Add timeout to agent loop

Priority 2 (code quality, do soon):
- Rename agent/trade-agent.ts to disambiguate from trading/trade-agent.ts
- Consolidate system prompts
- Log LLM parse failures instead of silently returning null
- Add filledQuantity validation to OrderResultSchema for FILLED orders

Priority 3 (nice to have, do when convenient):
- Add composite index on trades (status, symbol, trader) for backtest perf
- Deduplicate EOD sweep tasks
- Add opt-in staleQuotes flag to backtest market data
- Fix wall-clock MTM throttling in backtest runner
