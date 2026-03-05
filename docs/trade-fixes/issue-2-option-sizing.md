# ISSUE-2: Option Sizing Uses Underlying Price Instead of Premium

## Root Cause

**Not a bug.** The code already calls `getSpreadMidpoint` (the option premium midpoint) for
options and spreads in `getEntryPriceEstimate`. The reported symptom (entryPrice=197.13, floored
to 1 contract) points to a **different bug**: `spreadMaxRisk` is never passed to
`calculatePositionSize` from the OPEN path in `execute-resolved.ts`.

However, re-reading the bug report more carefully — "entryPrice=197.13 (stock)" — the
`entryPrice` stored at trade-record time is the **fill price** (`fp` from `recordFill`), not the
pre-sizing estimate. So the stored `entryPrice` being a stock price is a separate data issue.

The sizing estimate itself **is correctly using the option premium**. Here is the trace:

## Evidence — Full Trace

### Step 1: `getEntryPriceEstimate` (execute-resolved.ts:323-330)

```ts
async function getEntryPriceEstimate(legs: Leg[], broker: BrokerService): Promise<number> {
  if (legs[0].type === 'stock') {
    const quote = await broker.getQuote(legs[0].symbol);
    return (quote.bid + quote.ask) / 2;
  }
  // Options/spreads: quote the actual contract(s), not the underlying.
  return getSpreadMidpoint(broker, legsToOrderLegs(legs, 1));
}
```

- Stock path: calls `broker.getQuote(ticker)` → underlying price. CORRECT.
- Option/spread path: calls `getSpreadMidpoint(broker, legsToOrderLegs(legs, 1))`. This converts
  each `Leg` to an `OrderLeg` with the OCC symbol (e.g. `PANW 250117C00197000`), then fetches the
  option bid/ask directly. CORRECT — this returns the **option premium**, not the stock price.

### Step 2: `getSpreadMidpoint` (spread-midpoint.ts:17-45)

```ts
for (const leg of legs) {
  const quote = await broker.getQuote(leg.symbol);  // leg.symbol = OCC symbol
  ...
}
```

Each leg's `.symbol` is the OCC formatted option symbol at this point. CORRECT.

### Step 3: Sizing in `calculateNotionalSize` (position-sizing/index.ts:38)

```ts
const rawQty = Math.floor(targetNotional / (entryPrice * multiplier));
```

- `multiplier = contractMultiplier(strategy) = 100` for options. CORRECT.
- `entryPrice` = option premium (e.g. $8.65). CORRECT.
- Result: `floor(5000 / (8.65 * 100)) = floor(5000 / 865) = 5 contracts`. CORRECT.

### Step 4: Where the bug would actually appear

The reported `entryPrice=197.13` stored in trades is NOT from sizing — it's from the **fill
price** passed to `recordFill` at line 310-313 (execute-resolved.ts):

```ts
await pending.recordFill(
  result.filledPrice!,   // ← fill price from broker
  new Date(result.fillTimestamp!),
);
```

If `SimBroker` or `IbkrBroker` returns a fill price in the underlying's scale (e.g. 197.13 for a
stock price instead of 8.65 for the option premium), that is where the wrong value enters the DB.

## Real Issue: `spreadMaxRisk` Not Passed for Spreads

There IS a real gap, though it's not the one described. In the OPEN path at
`execute-resolved.ts:363-369`:

```ts
const entryPrice = await getEntryPriceEstimate(signal.legs, deps.broker);
const size = await deps.calculatePositionSize({
  trader,
  symbol,
  entryPrice,
  strategy,
  // ← spreadMaxRisk is MISSING here
});
```

The `calculatePositionSize` signature on `ResolvedPipelineDeps` (execute-resolved.ts:49-56)
accepts `spreadMaxRisk?: number`, and `buildPipelineDeps` forwards it to the sizer. But
`executeResolvedSignal` never computes or passes `spreadMaxRisk`.

For spreads (CDS/PDS/PCS), sizing should ideally use `max risk = spread_width * 100` rather than
the net premium, because that represents the maximum capital at risk. But since `spreadMaxRisk` is
currently unused in `calculateNotionalSize` (it's defined in `SizingParams` but never read), this
is a dead parameter — not a live bug.

## Proposed Fix

### Fix A: Verify fill price source (primary investigation)

Check `SimBroker` and `IbkrBroker` `placeOrder` return values. If the broker is returning an
underlying price as `filledPrice` for option orders, fix it there. This is the most likely source
of `entryPrice=197.13` in the DB.

Check `src/broker/sim/` and `src/broker/ibkr/` for how `filledPrice` is set on option fills.

### Fix B (optional, future): Use spread max risk for spread sizing

If we want to switch spread sizing to use max capital at risk:
1. In `execute-resolved.ts` OPEN path, compute `spreadMaxRisk` for spreads:
   ```ts
   const spreadWidth = getSpreadWidth(orderLegsToTradelegs(signal.legs));
   const spreadMaxRisk = spreadWidth > 0 ? spreadWidth * 100 : undefined;
   ```
2. Pass `spreadMaxRisk` to `calculatePositionSize`.
3. Update `calculateNotionalSize` to use `spreadMaxRisk` when present:
   ```ts
   const unitCost = params.spreadMaxRisk ?? (entryPrice * multiplier);
   const rawQty = Math.floor(targetNotional / unitCost);
   ```

This is a policy decision, not a bug fix. Current behavior (size on net premium) is defensible.

## Files Touched

- `src/pipeline/execute-resolved.ts` — `getEntryPriceEstimate` is CORRECT. No change needed here
  unless SimBroker fill price is wrong.
- `src/position-sizing/index.ts` — sizing formula is CORRECT given correct entryPrice input.
- `src/lib/trade.ts` — `contractMultiplier` is CORRECT (100 for options).
- `src/pipeline/spread-midpoint.ts` — CORRECT, uses OCC symbols.
- `src/broker/sim/` — **INVESTIGATE** for fill price correctness on option orders.
- `src/broker/ibkr/` — **INVESTIGATE** for fill price correctness on option orders.

## Risk

- Changing from premium-based to max-risk-based sizing would **reduce** option quantities (max
  risk is always >= premium for debit spreads, often much larger). Be sure this is intentional.
- If the broker fill price is wrong, fixing it will correct historical sizing symptoms but won't
  change future sizing (already correct pre-fill).

## Intersections

- **ISSUE-3 (missed TSLA signal)**: Also touches execute-resolved.ts. Coordinate changes.
- **BUG-4 (ABNB PUT direction)**: Also touches option leg resolution. If option type detection
  changes, `getEntryPriceEstimate` → `legsToOrderLegs` would pick up the correct OCC symbol.
- **`spreadMaxRisk` dead parameter**: CLAUDE.md "CLEAN AS YOU GO" — if this parameter is never
  used, either implement it or remove it from the interface to avoid confusion.

## Reviewer Verification

Reviewed 2026-03-04 by verifying every claim against the SQLite database (`data/trade-follower.db`)
and the actual source code.

### Claim 1: "Not a bug" — getEntryPriceEstimate uses option premiums

**CONFIRMED.** Read `src/pipeline/execute-resolved.ts` lines 324-331. The function does exactly
what the doc says:

- Stock path (line 325-327): `broker.getQuote(legs[0].symbol)` returning underlying midpoint.
- Option/spread path (line 330): `getSpreadMidpoint(broker, legsToOrderLegs(legs, 1))`.

`legsToOrderLegs` (lines 195-223) calls `formatOccSymbol()` for option legs, producing proper OCC
symbols (e.g. `RBLX  250905C00125000`). `getSpreadMidpoint` (`src/pipeline/spread-midpoint.ts`
lines 17-45) then calls `broker.getQuote(leg.symbol)` where `leg.symbol` is the OCC symbol. This
returns the option premium bid/ask, not the underlying price. The sizing estimate is correct.

### Claim 2: entryPrice=197.13 / stock-price-scale entries exist in DB

**CONFIRMED with nuance.** There is no trade with `entry_price=197.13` specifically, but there ARE
6 backtest option trades with entry prices at obvious stock-price scale:

```sql
SELECT id, symbol, strategy, entry_price, backtest_run_id
FROM trades
WHERE is_backtest = 1
  AND strategy IN ('PUT','CALL','CDS','PDS','PCS','NAKED_CALL','STRANGLE')
  AND CAST(entry_price AS REAL) > 50
ORDER BY CAST(entry_price AS REAL) DESC;
```

| symbol | strategy | entry_price | run status |
|--------|----------|-------------|------------|
| AAPL   | CALL     | 238.48      | CANCELLED  |
| RBLX   | CALL     | 133.77      | CANCELLED  |
| RBLX   | CALL     | 133.77      | CANCELLED  |
| RBLX   | CALL     | 133.77      | CANCELLED  |
| JOBY   | PUT      | 61.50       | COMPLETED  |
| ACHR   | PUT      | 56.38       | COMPLETED  |

All 6 are from early backtest runs. The JOBY entry ($61.50 for a $15 strike PUT) and ACHR entry
($56.38 for a $10 strike PUT) are clearly stock prices, not option premiums. These trades also have
`"symbol":"JOBY"` (ticker) in their legs JSON, not OCC symbols — confirming they were produced by
an earlier code version before `legsToOrderLegs` was fixed.

**Zero live trades** have this problem. All 169 live option trades have entry prices in the
expected option premium range ($0.20-$9.65).

Out of 2,485 total backtest option trades, only 6 (0.24%) have entry_price > $50. The bug is
historical/residual, not present in current code.

### Claim 3: SimBroker fill price returns option premium, not underlying

**CONFIRMED.** Read `src/backtest/sim-broker.ts`:

- For LIMIT option orders (lines 308-356): calls `getOptionSpreadQuote()` (line 317-318) which
  constructs OCC symbols via `formatOccSymbol()` from `params.symbol` + `leg.expiry/type/strike`
  (lines 182-188), fetches option quotes, and computes net bid/ask. Fill price is derived from
  option spread bid/ask with price improvement (lines 337-345).
- For MARKET option orders (lines 359-385): same `getOptionSpreadQuote()` call (line 362-363),
  then `computeModelFillPrice()` on the spread bid/ask (lines 370-377).

In both cases, `filledPrice` returned by SimBroker IS the option premium (spread midpoint or
fill-model-adjusted spread price), NOT the underlying stock price. The doc's hypothesis that
SimBroker might return an underlying price is **REFUTED** for the current code. The suspicious
entries are from early runs that likely had a different fill path.

### Claim 4: spreadMaxRisk is a dead parameter

**CONFIRMED.** In `src/position-sizing/index.ts` line 26:

```ts
function calculateNotionalSize(config: NotionalSizingConfig, params: SizingParams): PositionSize {
  const { entryPrice, equity, strategy, maxQuantity } = params;
```

`spreadMaxRisk` is destructured nowhere in `calculateNotionalSize`. It exists in `SizingParams`
(line 16) and is forwarded in `build-deps.ts` (line 173: `spreadMaxRisk: input.spreadMaxRisk`),
but the sizer never reads it. Dead parameter confirmed.

### Claim 5: spreadMaxRisk missing from OPEN path call

**CONFIRMED.** `src/pipeline/execute-resolved.ts` lines 365-370:

```ts
const size = await deps.calculatePositionSize({
  trader,
  symbol,
  entryPrice,
  strategy,
});
```

No `spreadMaxRisk` is passed. However, since `calculateNotionalSize` never reads it anyway
(Claim 4), this omission has zero runtime impact. The doc correctly identifies this as a dead
parameter, not a live bug.

### Claim 6: legsToOrderLegs produces OCC symbols

**CONFIRMED.** `src/pipeline/execute-resolved.ts` lines 195-223. For option legs, it calls
`formatOccSymbol()` from `src/lib/occ-symbology.ts` (lines 271-297), which produces standard
21-char OCC symbols (6-char padded underlying + YYMMDD + C/P + 8-digit strike*1000).

### Claim 7: Trade data shows suspicious stock-price-scale entry prices

**CONFIRMED — but limited scope.** The suspicious entries are:

- 6 trades with entry_price > $50 (clearly stock prices, not premiums)
- All from early backtest runs (4 CANCELLED, 2 from a COMPLETED early run)
- Zero live trades affected
- The affected trades have ticker symbols (not OCC) in their legs JSON, confirming they predate
  the current OCC symbol construction in `legsToOrderLegs`

Additional finding: The RBLX CALL at entry=$133.77 (stock price) can be directly compared to the
same RBLX CALL $125 strike from later runs at entry=$9.06 (option premium). Same underlying,
same strike, same expiry — different runs. The later run has OCC symbol
`RBLX  250905C00125000` in legs; the earlier run has just `RBLX`.

### Overall Verdict

**The "not a bug" conclusion is CONFIRMED for the current codebase.** The sizing pipeline
(`getEntryPriceEstimate` -> `getSpreadMidpoint` -> `calculateNotionalSize`) correctly uses option
premiums. The 6 suspicious DB entries are residual from early backtest runs before the OCC symbol
construction was in place.

**The SimBroker fill price hypothesis is PARTIALLY REFUTED.** The current SimBroker code correctly
returns option premium as `filledPrice`. The suspicious entries more likely came from an older code
path where either (a) `getOptionSpreadQuote` did not exist and the broker fell back to
`getQuote(underlying)`, or (b) the legs passed to the broker had ticker symbols instead of OCC
symbols, causing the quote to resolve against the underlying equity.

**The `spreadMaxRisk` dead parameter claim is CONFIRMED.** It is defined in `SizingParams`,
forwarded in `build-deps.ts`, never passed from `executeResolvedSignal`, and never read in
`calculateNotionalSize`. All four touch points agree: dead code.

**Confidence: HIGH.** The current code is correct. No action needed for sizing or fill prices.
The `spreadMaxRisk` dead parameter should be either implemented or removed per CLAUDE.md
"CLEAN AS YOU GO".
