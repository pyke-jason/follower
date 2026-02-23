Problem
SimBroker's buying power gate used `params.limitPrice ?? underlyingPrice` as the `entryPrice` for margin estimation. For MARKET option orders, `limitPrice` is null, so it fell back to the underlying stock price (e.g. GE at $282). The margin model then computed `debit = $282 × 8 contracts × 100 = $225,792` — more than the entire $100k starting balance — causing valid CDS trades to be rejected.

Decision
For MARKET option orders with no `limitPrice`, call `getOptionSpreadQuote` to get the actual net spread mid-price before running the margin check. If the spread quote fails (missing data), skip the buying power check entirely — the MARKET fill path already rejects with "no market data" if the quote is unavailable. LIMIT orders are unaffected (they already have an explicit price).

Key Files
- src/backtest/sim-broker.ts — placeOrder(): buying power gate now fetches spread quote for MARKET option orders
- src/backtest/margin-model.ts — computeMarginRequirement(): CDS/PDS LONG uses `entryPrice` as the net debit; must receive option price, not underlying price

Watch Out
The spread quote is fetched once for the margin check, then fetched again for the MARKET fill price (the two calls are structurally separate in placeOrder). This is minor redundancy but safe. A future refactor could hoist the spread quote fetch for MARKET option orders to reuse it across both paths.
