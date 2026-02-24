# Executor Rewrite Plan

Companion to:
- `docs/plan-prompt-simplification.md` — north star architecture
- `docs/plan-orchestrator-technical.md` — orchestrator design and output contract

---

## The Premise

The orchestrator (`src/intents/orchestrator/`) has already answered every hard question:
- What is the action (OPEN / CLOSE / TRIM / LEG_OFF)?
- Which exact contracts are being traded (resolved strikes, expiry)?
- For closes: which position does this exit (matched from DB)?
- What is the limit price (from stated premium or chain mid)?

By the time `ResolvedSignal[]` reaches the executor, there is nothing left to resolve. The executor is a mechanical wrapper: **sizing → risk → broker → record.**

---

## Current Executor Problems

`src/pipeline/execute.ts` was designed for the old `Signal[]` contract where the LLM emitted partial information (hint legs with `strike=0`, unresolved expiry, etc.). It compensates with:

- `resolveSignalLegs()` — ATM inference when strikes were missing
- `findPosition()` — position lookup for every CLOSE/TRIM/LEG_OFF
- Five separate executors (`executeOpen`, `executeClose`, `executeTrim`, `executeLegOff`, `executeAdd`)
- `deduplicateSignals()` — deduplicate LLM hallucinations
- `buildOrderFromSignal()` — builds OCC legs from a Signal

With the orchestrator as source of truth, all of this resolution work is done before the executor is called. The five executors collapse into one function.

---

## What the Executor Needs

`ResolvedSignal` provides concrete legs. The executor derives everything else from them:

| Needed for | How to get it |
|---|---|
| `symbol` | `legs[0].symbol` (underlying on all legs) |
| `strategy` | leg count + option types: 2 calls → CDS, 2 puts → PDS, 1 call → CALL, 1 put → PUT, stock → STOCK |
| `direction` | net side: debit / single BUY → LONG, credit / single SELL → SHORT |
| `action` | probe DB: position with these OCC symbols exists → CLOSE/TRIM/LEG_OFF, else → OPEN |
| `tradeId` | from the same DB probe |
| `exitPercent` | `signal.legs[0].quantity / position.quantity` |
| `targetStrategy` | which position leg is NOT in the signal legs = the leg being kept |

One DB probe per signal. That's it.

---

## New Executor Shape

```
executeResolvedSignals(signals, trader, deps, opts):
  for each signal:
    symbol    = legs[0].symbol
    strategy  = deriveStrategy(legs)
    direction = deriveDirection(legs)

    position = findByOccSymbols(legs, trader, deps)

    if position:
      action = inferCloseAction(legs, position)   // CLOSE, TRIM, or LEG_OFF
      orderLegs = legsToOrderLegs(legs)           // OptionLeg → OCC OrderLeg
      mid = getSpreadMidpoint(broker, orderLegs)
      params = buildCloseOrderParams(strategy, orderLegs, mid)
      place + record(action, tradeId=position.id, exitPercent?, ...)

    else:
      size = calculatePositionSize(symbol, strategy, ...)
      risk = checkRiskLimits(symbol, strategy, trader, 'OPEN')
      orderLegs = legsToOrderLegs(legs, size.quantity)  // × lot count
      mid = getSpreadMidpoint(broker, orderLegs)
        // or use signal.limitPrice if orchestrator provided one
      params = buildOpenOrderParams(strategy, orderLegs, mid)
      place + record(OPEN, ...)
```

`legsToOrderLegs()` is the only new helper — it converts `OptionLeg` (underlying, expiry YYYY-MM-DD, strike, optionType, side, quantity) to `OrderLeg` (OCC symbol, Date expiry, action, quantity × lotCount).

---

## OCC Symbol Matching

`findByOccSymbols(legs, trader, deps)`:
1. Convert each `OptionLeg` in the signal to an OCC symbol via `formatOccSymbol()`
2. Load open positions for `trader` filtered by `symbol`
3. Find the position whose stored leg OCC symbols overlap with the signal's OCC symbols (any leg in common = this position)
4. Return position or null

Fuzzy fallback (same as today): if no strategy match, fall back to single-position-on-symbol match.

---

## Inferring Close Action

`inferCloseAction(signalLegs, position)`:

- **CLOSE**: signal leg OCC symbols === all position leg OCC symbols, and quantity matches `position.quantity`
- **TRIM**: same OCC symbols, but `signalLegs[0].quantity < position.quantity`
- **LEG_OFF**: signal covers a strict subset of the position's legs (e.g., only the SELL leg of a CDS)

---

## What Gets Deleted

| Current code | Fate |
|---|---|
| `executeOpen`, `executeClose`, `executeTrim`, `executeLegOff`, `executeAdd` | Deleted — replaced by single `executeResolvedSignals` |
| `resolveSignalLegs()` in `signal-legs.ts` | Deleted — orchestrator resolves legs before executor |
| `buildOrderFromSignal()` | Deleted — replaced by `legsToOrderLegs()` |
| `deduplicateSignals()` | Deleted — orchestrator guarantees one signal per intent |
| `buildOrderLegs()` in `signal-legs.ts` | May keep for backtest compatibility, or delete |

`executeSignals(Signal[], ...)` stays temporarily for the backtest path until it's migrated.

---

## Wiring

**`extract-intent.ts`**:
- Calls `resolveOrchestrator(ctx, provider)`
- Returns `OrchestratorResult` directly to the runner
- No conversion to old `Signal[]`
- Circular dep fix: move `createIntentTools` / `intentOnToolCall` to `src/intents/intent-tools.ts` (both `extract-intent.ts` and `llm-path.ts` import from there)

**`tasks/runner.ts`**:
- Passes `getPositions` dep (adapter from `Trade[]` to `OpenPosition[]` shape)
- Calls `executeResolvedSignals()` when `OrchestratorResult.outcome === 'EXECUTE'`

**`backtest/runner.ts`**:
- Same migration, separate PR

---

## Migration Order

1. Fix circular dep (`intent-tools.ts` extraction) — isolated, no behavior change
2. Wire `extract-intent.ts` → `resolveOrchestrator()` — activates orchestrator for live
3. Write `executeResolvedSignals()` alongside existing `executeSignals()` — no deletion yet
4. Update `tasks/runner.ts` to use new path
5. Validate against eval suite + live canary
6. Delete old executor code and `signal-legs.ts`
7. Migrate backtest runner
