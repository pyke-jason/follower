# Replace get_options_chain with get_option_quote

## Problem

During backtest intent extraction, the LLM calls `get_options_chain` which constructs 69-110 candidate OCC symbols across a +/-20% strike range and fetches tick data for ALL of them from Databento. This happens for every symbol the LLM considers -- including ones it doesn't trade. Example: ARM (110 symbols) and ABNB (101 symbols) chains were fetched when only UPS had an order.

SimBroker's `getOptionSpreadQuote` also calls `getOptionsChain` purely to warm the dayTicks cache before calling `getQuote(occSymbol)` per leg -- redundant since `getQuote` already handles OCC symbols via `loadDay()`.

## Fix

Replace the `get_options_chain` LLM tool with `get_option_quote(symbol, expiry, optionType, strike)` that fetches a single contract. The LLM already has heuristics for computing ATM strikes; it just needs to validate individual quotes, not scan an entire chain. Remove the chain-warming block from SimBroker.

## Changes

### 1. Add `get_option_quote` tool, remove `get_options_chain` tool

src/agent/schemas.ts
- Add `GetOptionQuoteInput`: `{ symbol, expiry, optionType, strike: z.number().positive() }`
- Remove `GetOptionsChainInput`

src/agent/tool-factory.ts
- Add `getOptionQuoteTool(cb)` -- takes `(symbol, expiry, optionType, strike) => Promise<Quote>`, builds OCC symbol internally via `formatOccSymbol`, returns a Quote
- Remove `getOptionsChainTool`
- Remove `OptionsChain` import

### 2. Update IntentExtractionDeps + tool wiring

src/intents/extract-intent.ts
- `IntentExtractionDeps`: replace `getOptionsChain` field with `getOptionQuote: (symbol, expiry, optionType, strike, at) => Promise<Quote>`
- `createIntentTools()`: wire `getOptionQuoteTool` pinned to `msgTime`
- Bump `INTENT_VERSION` from 1 to 2 (invalidates cached intents that used old tool)

### 3. Update system prompt

src/intents/extract-intent.ts -- INTENT_SYSTEM_PROMPT
- Step 3 (line 63): "Call get_quote and get_option_quote to verify prices and strikes"
- Replace `<inferring_strikes>` section (lines 99-110):
  1. Get stock price via get_quote
  2. Compute ATM strike by rounding to nearest standard increment ($0.50 under $25, $1 for $25-200, $5 for >$200)
  3. Compute second leg using width heuristic (already in prompt)
  4. Call get_option_quote per leg to validate. If no data, try next standard strike
  5. For premium matching ("for .09"), try 2-3 nearby combos with get_option_quote
- Update examples that mention get_options_chain (line 138)

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

src/backtest/runner.ts -- wire `getOptionQuote` in `intentDeps` using `formatOccSymbol` + `priceProvider.getQuote`
src/tasks/runner.ts -- wire `getOptionQuoteTool` in `classificationTools` using `formatOccSymbol` + `liveService.getQuote`
src/agent/agent-loop.ts -- update tool output summary (line 48): replace `get_options_chain` branch with `get_option_quote`
src/backtest/test-fixtures.ts -- remove `getOptionsChain` stubs from all three helpers
src/orders/order-manager.test.ts -- remove `getOptionsChain: vi.fn()` from mock broker

### 7. NOT changing

- `DatabentoMarketDataProvider.getOptionsChain()` concrete method -- keep it, just remove from interface
- `tradestation.ts` `getOptionsChain` export -- keep it, just remove from `BrokerService` interface
- `trade-agent.ts` -- no LLM prompt here, it's rule-based

## Verification

1. `npx tsc --noEmit` -- compile check surfaces any missed consumers
2. `npm test` -- SimBroker property tests, order-manager tests all pass
3. Run a short backtest on a date with known options trades -- confirm:
   - No "constructed OCC symbols" log lines during intent extraction
   - SimBroker fetches only leg-specific OCC symbols (2 per spread, not 100)
   - Same trade results as before
4. Smoke test live path: verify `liveService.getQuote(occSymbol)` works with TradeStation's quote endpoint

## Risk

- **Premium matching**: LLM tries 2-3 combos instead of scanning full chain. Slightly more LLM tokens, dramatically less data cost. The heuristic already narrows the search.
- **TradeStation OCC quotes**: The live `getQuote` endpoint should accept OCC symbols (placeOrder already uses them), but verify before deploying live.
- **Strike validation**: If computed strike doesn't exist, `getQuote` will throw. Prompt instructs LLM to try next standard strike. Same behavior as current "flag for review if strike not in chain."
