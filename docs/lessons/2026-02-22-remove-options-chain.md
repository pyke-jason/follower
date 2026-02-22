Problem
During backtest intent extraction, the LLM called get_options_chain for every symbol it considered (not just the one it traded). Each call constructed 69-110 candidate OCC symbols and fetched tick data from Databento for all of them. A single message mentioning ARM, ABNB, and UPS caused ~280 option contracts to be fetched when only 2 UPS legs were needed. SimBroker's getOptionSpreadQuote also called getOptionsChain purely to warm the dayTicks cache before calling getQuote per leg — redundant since getQuote already handles OCC symbols via loadDay().

Decision
Removed get_options_chain entirely — no replacement tool. The LLM already has heuristics for computing ATM strikes from the stock price ($0.50/$1/$5 rounding + width rules). Strike validation now happens at execution time when SimBroker calls getQuote(occSymbol) per leg. Bumped INTENT_VERSION from 1 to 2 to invalidate cached intents that used the old tool.

Key Files
src/agent/tool-factory.ts — removed getOptionsChainTool builder
src/agent/schemas.ts — removed GetOptionsChainInput
src/intents/extract-intent.ts — removed from IntentExtractionDeps, createIntentTools, updated system prompt (inferring_strikes section), bumped INTENT_VERSION
src/backtest/sim-broker.ts — deleted chain-warming block in getOptionSpreadQuote (lines 138-156), removed getOptionsChain passthrough method
src/backtest/market-data.ts — removed getOptionsChain from MarketDataProvider interface (kept concrete method on DatabentoMarketDataProvider)
src/broker/interface.ts — removed getOptionsChain from BrokerService interface
src/broker/tradestation.ts — removed from liveService object (kept the standalone export)
src/backtest/test-fixtures.ts — removed stubs from all three helpers
src/agent/agent-loop.ts — removed tool output summary branch

Watch Out
The concrete getOptionsChain method still exists on DatabentoMarketDataProvider and as an export on tradestation.ts — just not on any interface. If you need it later for diagnostics, it's still there. Premium matching ("for .09") now relies on the LLM adjusting strikes rather than scanning the full chain — watch for accuracy on those cases. TradeStation getQuote with OCC symbols is assumed to work (placeOrder already uses OCC format) but hasn't been explicitly tested in the live path.
