Compacted Lessons — Trade Follower 3
Consolidated from 22 individual lessons (2026-02-20 through 2026-02-23).
Organized by theme, not chronology. Each section captures the "why" that code comments cannot.


--- TRADE LIFECYCLE ---

LEG_OFF action and trade events audit trail
  LEG_OFF fills the gap between CLOSE (all legs) and TRIM (partial quantity) for spread mutations like "exit CDS, hold straight calls." The same trade row stays open through the full lifecycle: OPEN CDS -> LEG_OFF (mutate to CALL, adjust cost basis) -> CLOSE CALL. Only two transitions exist: CDS->CALL, PDS->PUT. Cost basis = original spread debit + buyback cost. PnL is only computed at final CLOSE against the adjusted entry price. The trade_events table is an append-only event log alongside the denormalized trades row — readers are untouched, only the write path changed. targetStrategy flows through metadata from pipeline to record-trade; if metadata shape changes, both files break together.
  Key files: src/lib/enums.ts (TradeAction), src/pipeline/execute.ts (executeLegOff), src/trades/record-trade.ts (LEG_OFF handler + emitEvent), src/agent/schemas.ts (targetStrategy on SignalSchema).

TRIM normalization — no child trades
  TRIM originally created fake CLOSED child rows with parentTradeId, inflating trade counts and splitting PnL across parent+child. Now TRIM updates the parent row in place: reduce quantity, accumulate realizedPnl. CLOSE adds accumulated realizedPnl to the final PnL for the total. No child rows, no PARTIAL status. The event log captures trimQty, exitPrice, exitPercent, and trimPnl for audit. computeCoreStats() now counts 1 position = 1 trade, so old backtest run summaries (JSON blobs) will not match if re-computed from trades after migration. RecordTradeResult.tradeId for TRIM returns the parent trade ID, not a child ID.
  Key files: src/trades/record-trade.ts (TRIM in-place update, CLOSE PnL rollup), src/db/schema.ts (realizedPnl column), src/trades/filters.ts (isOpen = eq(status, 'OPEN'), no PARTIAL).

Strategy-aware position matching with fuzzy fallback
  Position lookup must filter by strategy, not just symbol + trader. Without it, "Exit Short GNRC pds" matched the wrong GNRC STOCK position because the query grabbed positions[0]. Exact strategy matching is safe even with LEG_OFF — by close time, the DB row's strategy already reflects the mutation. For CLOSE/TRIM/LEG_OFF, if exact {symbol, trader, strategy} match fails, a fuzzy fallback retries with just {symbol, trader}. If exactly 1 result, it uses it and logs the strategy mismatch. OPEN/ADD always require exact matching to avoid ambiguity. If a trader has multiple positions on the same symbol (e.g. CALL + PDS), the fuzzy fallback returns undefined and the close fails explicitly.
  Key files: src/pipeline/execute.ts (findPosition fuzzy helper), src/trades/filters.ts (forStrategy composable filter), src/trades/record-trade.ts (strategy in scopeFilters).

Leg deduplication in option signals
  LLM v4 sometimes emits duplicate legs in option signals, causing doubled prices/PnL. buildOptionLegs() in execute.ts now deduplicates by (strike|expiry|optionType|action) key before mapping SignalLeg to OrderLeg. This is the single conversion point for all OPEN/ADD paths. The dedup key includes action (BUY/SELL) so a legitimate spread with BUY+SELL on the same strike/expiry is preserved.
  Key files: src/pipeline/execute.ts (buildOptionLegs dedup).


--- SIGNAL PROCESSING ---

LLM boundary — intent extraction vs deterministic pipeline
  A UNH CDS trade exposed the core design problem: the LLM called get_quote, got the equity price ($353), and set it as limitPrice on a spread worth ~$3. The SELL LIMIT at $353 never filled. The fix draws a hard line: LLM parses text into structured intent, pipeline computes all numbers from market data. get_quote was removed from intent extraction (quotes already in prompt). limitPrice was renamed to statedPremium (informational only, never drives orders). Strike inference moved from LLM heuristics to deterministic code (inferATMSpread/inferATMStrike in occ-symbology.ts). All pipeline actions use MARKET orders. Pipeline fetches broker quote for entry price sizing.
  Key files: src/intents/extract-intent.ts (prompt, tool removal), src/agent/schemas.ts (statedPremium), src/backtest/occ-symbology.ts (inferATMSpread/inferATMStrike), src/pipeline/execute.ts (resolveSignalLegs, getEntryPriceEstimate, MARKET orders).

Options chain removal
  The LLM called get_options_chain for every symbol it considered, not just the one it traded. A single message mentioning ARM, ABNB, and UPS fetched ~280 contracts when only 2 legs were needed. The tool was removed entirely. The LLM already infers ATM strikes from stock price; strike validation now happens at execution time when SimBroker calls getQuote(occSymbol). Concrete getOptionsChain methods still exist on DatabentoMarketDataProvider and tradestation.ts for diagnostics — just removed from interfaces.
  Key files: src/intents/extract-intent.ts, src/agent/tool-factory.ts, src/backtest/sim-broker.ts, src/broker/interface.ts.

Strategy gate — deterministic enforcement
  Stock trades appeared in backtests despite traders having strategies: ["CDS","PDS","CALL","PUT"]. The strategies field was only a hint to the LLM prompt with zero pipeline enforcement. shouldSkipSignal() in deterministic-skips.ts enforces the gate at executeSignal() in pipeline/execute.ts — the single chokepoint both live and backtest paths share. Only blocks OPEN/ADD (position-increasing); CLOSE/TRIM/LEG_OFF always allowed so traders can exit after a strategy is disabled. allowedStrategies flows from traderProfile.strategies which is nullable and fails open on prefetch failure — a broken prefetch silently disables the gate.
  Key files: src/agent/deterministic-skips.ts (shouldSkipSignal), src/pipeline/execute.ts (enforcement at executeSignal), src/trading/trade-agent.ts (early-out).


--- ORDER MANAGEMENT ---

OrderManager unified for live + backtest
  Live trading previously bypassed OrderManager entirely — placeOrder() stripped cancelAfterSec and adjustmentRules for live, so backtests simulated price-chase and 60s auto-cancel but live did neither. Now OrderManager is wired into the live task runner with manualTick: false (wall-clock 1s auto-tick). Same onFill/onCancel callbacks, same pendingIntents map, same onPending handler. onFill callback is async but typed as () => void — the caller does not await it (safe because 1s tick interval >> recordTrade latency). pendingIntents map is in-memory — process crash loses pending order context.
  Key files: src/tasks/runner.ts (module-level OrderManager), src/orders/order-manager.ts, src/pipeline/execute.ts (placeOrder routing).

Zod boundary validation for orders
  Property-based analysis revealed three truthy-check bugs in OrderManager: maxSteps: 0 treated as unlimited (0 is falsy), cancelAfterSec: 0 as "no timeout", and the hasRules gate. Fixed to use != null. Cross-field constraints (LIMIT -> limitPrice, FILLED -> filledPrice + fillTimestamp) are enforced via Zod .refine() schemas parsed at entry points: OrderManager.submitOrder(), tick() parsing OrderResult, execute.ts placeOrder(). No ad-hoc throws in orchestration. FilledWorkingOrder type narrows the onFill callback, eliminating ! assertions in consumers. Zod .refine() does not narrow TS output types — the ! assertions on filledPrice/fillTimestamp after Zod parse are TypeScript necessities, not lazy escapes. Iterative price chase rounding (each step rounds to cents before the next) means cumulative properties do not hold — fast-check catches divergence at stepAmount=0.007 after ~3 steps.
  Key files: src/broker/order-schemas.ts (Zod schemas), src/broker/types.ts (FilledWorkingOrder), src/orders/order-manager.ts, src/orders/order-manager.test.ts (20 property tests).


--- MARKET DATA AND CACHING ---

Unified tick cache via fetchTickWindow + interval merging
  The old system fetched entire trading days (6.5 hours, ~390 records/symbol) via loadDay() even when consumers needed 1-2 minutes. All intraday data now flows through fetchTickWindow() with arbitrary start/end times. An interval-merging cache tracks which time ranges are covered per symbol on disk/DB, so overlapping requests merge rather than re-fetch. isRangeCovered() requires the stored interval to FULLY contain the requested range — partial coverage is a miss, which is why caches accumulate incrementally and why pre-seeding matters.
  Key files: src/backtest/databento-tape.ts (mergeRanges, isRangeCovered, fetchTickWindow), src/backtest/market-data.ts (ensureRange: memory -> DB -> API).

Tick cache day-key removal
  Tick cache files were keyed by symbol+day, causing cross-day quote failures when wide lookback windows crossed ET midnight. ensureRange cached under toDateKey(start) but getQuote looked up under toDateKey(at) — 114 records fetched but invisible to the lookup. Day was removed from tick cache keys entirely. v2 ranges are continuous UTC millisecond intervals; day scoping was v1 cruft. First migration attempt OOM'd loading all 62K files — streaming with 16KB header-only reads was required.
  Key files: src/backtest/databento-tape.ts (getSymbolCachePath, no day param), src/backtest/market-data.ts (tickCache keyed by symbol only).

Tick cache SQLite migration
  Moved from 708MB across 20,844 JSON files to a separate SQLite database at data/tick-cache.db (independent lifecycle from the web server DB). Four tables: quote_ticks (WITHOUT ROWID, composite PK on symbol+dbn_schema+timestamp), tick_cache_ranges (merged intervals), chain_definitions (WITHOUT ROWID), chain_cache_meta (fetched-but-empty vs never-fetched sentinel). dbn_schema is part of the quote_ticks PK because the same symbol can have ohlcv-1m and ohlcv-1d records — without it, minute bars and daily bars collide. In-memory Map hot cache stays; DB replaces disk as the persistence layer. Lookup path: memory -> DB -> API.
  Key files: src/db/tick-cache-schema.ts, src/db/tick-cache-client.ts, src/backtest/tick-cache-db.ts (DB access layer), src/backtest/market-data.ts, src/backtest/databento-tape.ts (file cache code removed).

Unified daily bars cache
  loadDailyBars was a separate per-day caching system for ohlcv-1d data with a Friday bug: Databento ts_event for Friday bars = Saturday 00:00Z, toDateKeyET mapped that to Sunday, causing cache misses and repeated API fetches on every run. Daily bars now flow through the same ensureRange + fetchTickWindow infrastructure. ensureRange got an optional schemaOverride param; in-memory cache key becomes "symbol:schema" to avoid mixing ohlcv-1d and ohlcv-1m. parseTick snaps non-trading-day timestamps to the previous trading day. DBEQ.BASIC ohlcv-1d returns 2-3 records per day per symbol (different exchange feeds); getBars deduplicates by keeping the highest-volume bar per trading day.
  Key files: src/backtest/databento-tape.ts (parseTick Friday fix, QuoteTick extended), src/backtest/market-data.ts (getBars via ensureRange('ohlcv-1d')).

Daily bar preseed (Phase 1.5)
  Position sizing calls getBars() -> ensureRange('ohlcv-1d') on every EXECUTE message. prefetch() only warms 1-minute quote ticks, not daily bars. On cold cache, each new symbol/date triggers a 2-3s Databento call. Phase 1.5 runs between intent extraction (Phase 1) and message replay (Phase 2): collect all unique symbols from tradableMessages, call preSeedDailyBars() for the full backtest date range. Lookback is 15 trading days before startDate (ATR(14) + 1 for true range calculation). preSeedDailyBars() is a public wrapper around the private ensureRange() — do not attempt to inline the loop in runner.ts. The barsBack value (15) is a known constant; do not derive it from trader configs at runtime.
  Key files: src/backtest/runner.ts (Phase 1.5 block), src/backtest/market-data.ts (preSeedDailyBars).

Options quote lookback — execution vs valuation
  Illiquid option positions showed "No Databento data" during backtest valuation. Two fixes: (1) search ALL cached ticks for the day, not just the window-filtered subset — Databento cbbo-1s reports ts_event as when the quote was established, not the snapshot second, so the same BBO persists for hours with the original timestamp. (2) Default option lookback raised from 5 min to 300 min (5 hours) for valuation. Execution paths (fills, limit checks) explicitly pass EXECUTION_LOOKBACK_MINS = 5. The lookback window controls both what gets fetched AND max acceptable staleness — a tick found in full cache must still be younger than the current window's span.
  Key files: src/backtest/market-data.ts (getQuote full-cache search + staleness check), src/backtest/sim-broker.ts (EXECUTION_LOOKBACK_MINS at fill/limit sites).

Databento data cost awareness
  Never mass-delete .cache/databento/ files — they cost real money to re-fetch. Empty [] files are valid (weekends/holidays). SHA256-hashed filenames mean you cannot tell equity vs options by name. ATR position sizing originally fetched ~6,000 rows per symbol (15 days x ~390 ohlcv-1m records) across 15 separate HTTP requests — switching to ohlcv-1d schema reduced this to a single API call (~400x cheaper). INTENT_VERSION bumps force re-extraction of all cached intents (~$5-15 cost each time).


--- BROKER AND PRICING ---

SimBroker options margin check
  SimBroker's buying power gate used limitPrice ?? underlyingPrice as entryPrice for margin. For MARKET option orders, limitPrice is null, falling back to the stock price (e.g. GE at $282 instead of a $3 spread), rejecting valid trades. Fix: for MARKET option orders, call getOptionSpreadQuote to get the actual net spread mid-price before the margin check. If the spread quote fails, skip the buying power check (the MARKET fill path already rejects on missing data). Also replaced hardcoded contractMult=100 in margin-model.ts with contractMultiplier(strategy) from lib/trade.ts.
  Key files: src/backtest/sim-broker.ts (placeOrder buying power gate), src/backtest/margin-model.ts (contractMultiplier).

OCC symbology consolidation
  tradestation.ts had a private buildOccSymbol that reimplemented formatOccSymbol with a date-parsing bug: new Date(expiry) shifts dates in non-UTC timezones. Replaced with the shared formatOccSymbol from occ-symbology.ts, which parses YYYY-MM-DD strings directly without going through Date constructors.
  Key files: src/broker/tradestation.ts (uses shared formatOccSymbol), src/backtest/occ-symbology.ts (canonical implementation).


--- POSITION SIZING ---

Factory pattern with per-trader config
  buildPositionSizer() is a discriminated union factory on strategy field. Currently only ATR strategy. Per-trader config (riskPercent, atrMultiplier, atrPeriod) stored in DB, exposed as Risk % in the trader roster UI. ATR-specific params (atrMultiplier, atrPeriod) deliberately hidden from UI — the ATR strategy is behind the factory, cleanly replaceable with zero UI changes. buildPositionSizer(null, ...) returns the default (5% risk, 2x ATR, 14 period); clearing the field -> null -> system default. Backtest runner was fixed to do per-trader config lookup matching the live runner pattern.
  Key files: src/position-sizing/index.ts (factory), web/app/traders/actions.ts (setRiskPercent preserves ATR params), web/app/traders/trader-roster.tsx (Risk % column).


--- PIPELINE SAFETY ---

Silent DB failures — re-throw infrastructure errors
  executeSignals() caught ALL errors and logged them as warnings. When trade_events table was missing, every insert threw DrizzleQueryError, but the pipeline caught it and continued. The backtest ran to completion with zero trades, looking like a parsing issue. Fix: infrastructure errors (DrizzleQueryError — DB down, missing table) are re-thrown; business logic errors (no open position, risk blocked) remain as warnings. The distinction: a DB error means the system is broken; a signal error means this trade cannot execute but the next one might. The original trigger was applying a migration to data.db at the project root instead of data/trade-follower.db where the app connects.
  Key files: src/pipeline/execute.ts (DrizzleQueryError re-throw in catch block).

Test fixtures for new tables
  After recordTrade started emitting to trade_events, 22 of 89 sim-broker tests failed because in-memory SQLite test databases only created the trades table. Pattern: export a CREATE_<TABLE>_SQL in test-fixtures.ts, import it in each test file's beforeAll, add a DELETE in resetDb(). FK constraints are omitted from test tables to avoid cascade issues. Any new table that recordTrade (or code it calls) writes to needs a matching CREATE TABLE in test-fixtures.ts.
  Key files: src/backtest/test-fixtures.ts (CREATE_TRADE_EVENTS_SQL, resetDb).


--- UI ARCHITECTURE ---

Unified ChatRoom with constraints
  The backtest detail page had a separate EnrichedChatPanel duplicating state management, pagination, and filter logic from ChatRoom. Unified on ChatRoom as the single message browsing component with a constraints prop for locked filter scope (authors, date range, runId, lastProcessedTs). When runId is in constraints, the fetch pipeline also loads enrichment data (decisions + trades). The filter bar adapts: shows locked state and decision filters (executed/skipped) when run-scoped. Decision summary counts in the filter bar are approximate (page-scoped, not total).
  Key files: web/app/messages/chat-room.tsx (FilterConstraints, enrichment state), web/app/messages/chat-filters.tsx, web/app/messages/actions.ts, web/app/backtests/[id]/page.tsx.

Messages page label filters and split layout
  The eval page was deleted — all review workflows moved to the Messages page with four filter modes: Labeled, Unlabeled, Mismatched, Needs Review. The "mismatched" filter cannot be done purely in SQL (requires comparing JSON signal arrays between messageLabels and messageIntents), so it over-fetches labeled messages (4x page size), filters mismatches in JS, then trims to page size. Split-layout panel shows related messages by symbol on click. The needs-review JOIN on messageIntents may return duplicate messages if multiple intent versions exist — acceptable since deduplication happens client-side via message ID keying.
  Key files: web/app/messages/actions.ts (LabelFilter, mismatched post-filter), web/app/messages/chat-room.tsx (split layout), web/app/messages/chat-filters.tsx, src/lib/eval.ts (compareSignals).
