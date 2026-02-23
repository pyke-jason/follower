# Remove get_options_chain tool

## Problem

During backtest intent extraction, the LLM calls `get_options_chain` which constructs 69-110 candidate OCC symbols across a +/-20% strike range and fetches tick data for ALL of them from Databento. This happens for every symbol the LLM considers -- including ones it doesn't trade. Example: ARM (110 symbols) and ABNB (101 symbols) chains were fetched when only UPS had an order.

SimBroker's `getOptionSpreadQuote` also calls `getOptionsChain` purely to warm the dayTicks cache before calling `getQuote(occSymbol)` per leg -- redundant since `getQuote` already handles OCC symbols via `loadDay()`.

## Fix

Remove `get_options_chain` entirely. The LLM already has heuristics for computing ATM strikes from the stock price (via `get_quote`). Strike validation happens at execution time when SimBroker calls `getQuote(occSymbol)` per leg. No new tool needed.

## Changes

### 1. Remove `get_options_chain` tool

src/agent/schemas.ts -- remove `GetOptionsChainInput`
src/agent/tool-factory.ts -- remove `getOptionsChainTool`, remove `OptionsChain` import

### 2. Update IntentExtractionDeps + tool wiring

src/intents/extract-intent.ts
- `IntentExtractionDeps`: remove `getOptionsChain` field
- `createIntentTools()`: remove `getOptionsChainTool` from tool array
- Bump `INTENT_VERSION` from 1 to 2 (invalidates cached intents that used old tool)

### 3. Update system prompt

src/intents/extract-intent.ts -- INTENT_SYSTEM_PROMPT
- Step 3 (line 63): change to "Call get_quote to verify the stock price aligns with the trader's message."
- Replace `<inferring_strikes>` section (lines 99-110):
  1. Get the current stock price via get_quote
  2. Compute ATM strike by rounding to nearest standard increment ($0.50 under $25, $1 for $25-200, $5 for >$200)
  3. Compute second leg using width heuristic ($2.50 if <$50, $5 if $50-200, $10 if >$200)
  4. For PDS: long (BUY) = ATM, short (SELL) = ATM - width. For CDS: long = ATM, short = ATM + width
  5. If the trader mentions a net premium ("for .09"), adjust strikes narrower/wider to approximate
  6. Use the stated premium as limitPrice (or mid of estimated debit if not stated)
  7. If a trader-specified strike seems implausible (far from ATM), flag for review
- Update examples that mention get_options_chain (line 138)
- Remove line 109 ("If a trader-specified strike does not exist in the chain, flag for review")

### 4. Remove chain warming from SimBroker

src/backtest/sim-broker.ts
- Delete lines 138-156 (the cache-warming block in `getOptionSpreadQuote`)
- The subsequent `getQuote(occSymbol)` calls already work via `loadDay()` which auto-detects OCC symbols and uses the OPRA dataset
- For a 2-leg spread: 2 single-symbol fetches instead of ~100

### 5. Remove `getOptionsChain` from interfaces

src/backtest/market-data.ts -- `MarketDataProvider` interface: remove `getOptionsChain`
  (keep the concrete method on `DatabentoMarketDataProvider` for potential diagnostics)

src/broker/interface.ts -- `BrokerService` interface: remove `getOptionsChain`
  (keep the function export on tradestation.ts)

### 6. Update all consumers

src/backtest/runner.ts -- remove `getOptionsChain` from `intentDeps`
src/tasks/runner.ts -- remove `getOptionsChainTool` from `classificationTools`, remove import
src/agent/agent-loop.ts -- remove `get_options_chain` branch in tool output summary (line 48)
src/backtest/test-fixtures.ts -- remove `getOptionsChain` stubs from all three helpers
src/orders/order-manager.test.ts -- remove `getOptionsChain: vi.fn()` from mock broker

### 7. NOT changing

- `DatabentoMarketDataProvider.getOptionsChain()` concrete method -- keep it, just remove from interface
- `tradestation.ts` `getOptionsChain` export -- keep it, just remove from `BrokerService` interface
- `trade-agent.ts` -- no LLM prompt here, it's rule-based
- `get_quote` tool -- unchanged, already works for equity tickers

## Verification

1. `npx tsc --noEmit` -- compile check surfaces any missed consumers
2. `npm test` -- SimBroker property tests, order-manager tests all pass
3. Run a short backtest on a date with known options trades -- confirm:
   - No "constructed OCC symbols" log lines during intent extraction
   - SimBroker fetches only leg-specific OCC symbols (2 per spread, not 100)
   - Same trade results as before

## Risk

- **Premium matching**: Without the chain, the LLM uses stated premium as limitPrice rather than scanning strikes. This is fine -- the trader usually states the price they want.
- **Strike inference accuracy**: The heuristic ($0.50/$1/$5 rounding) covers standard strikes well. Non-standard increments (e.g., $2.50 strikes on some ETFs) would require the LLM to guess. If wrong, SimBroker's `getQuote(occSymbol)` will fail at execution time and the order won't place -- same outcome as current "flag for review."
