# Legs-first execution: kill the action enum

## North star

The entire execution pipeline reduces to one concept: **a ledger of BUY/SELL orders for securities, grouped by strategy.**

That's what brokers accept. That's what the orchestrator already produces. Everything between — `deriveAction()`, the action enum, the 5-branch switch in `recordTrade` — is invented complexity that re-labels what the data already says.

### What the system looks like at steady state

```
Chat message
  → Orchestrator (parse intent, resolve to concrete legs)
  → Executor (send legs to broker, get fills)
  → Portfolio reconciler (apply fills to positions — derive what happened from the data)
  → Event log (audit trail with derived labels)
```

**The orchestrator doesn't change.** It already outputs `{ legs: [BUY 755C, SELL 765C], limitPrice?, tradeId? }`. That's a ledger entry.

**The executor doesn't need `deriveAction()`.** It just needs to know: is this opening a new position (`!tradeId`) or transacting against an existing one (`tradeId`)? That's a boolean, not a 5-value enum.

**`recordTrade` becomes a portfolio reconciler.** It receives fills (legs + prices) and reconciles them against existing positions. The "action" falls out of the comparison:

| Incoming legs vs existing position | What happened |
|---|---|
| No existing position | New position opened |
| Same-direction legs | Position grew |
| Reversal of all legs, full qty | Position closed |
| Reversal of all legs, partial qty | Position shrunk |
| Reversal of some legs | Spread shape changed (leg removed) |

These labels are derived for the event log and UI. They're never inputs.

**`TradeAction` stops being an API input.** It survives only as:
- A derived label on `trade_events` rows (for audit, display, rebuild)
- An internal routing hint in the orchestrator parser (to decide open-path vs position-path)
- An LLM output field (to help the model classify intent)

It never flows into the executor or recordTrade as a behavioral driver.

---

## Tactical: immediate bug fix

The META CDS $755/$765 bug. `deriveAction()` returns `'CLOSE'` for a single-leg reversal on a spread. `recordTrade` blindly closes the whole position.

**Fix in `record-trade.ts` only.** The CLOSE branch already receives the incoming legs and has the existing trade. Add leg comparison at the top of the branch:

- Existing position has 2+ legs (it's a spread)
- Incoming reversal covers only a subset
- → This is a partial leg close. Derive kept/closed legs, mutate the position in-place instead of closing it.

~40 lines. Zero type changes. Zero upstream changes. This is the first concrete step of the north star: making the CLOSE branch data-driven instead of label-driven.

### Detection

Match incoming reversal legs to existing position legs by `strike + type + expiry`. Both sides use the same field formats (OCC symbology from `formatOccSymbol`).

### Mutation

- Remove closed leg(s) from position
- Derive new strategy from remaining legs (single CALL → `'CALL'`, single PUT → `'PUT'`)
- Adjust entry basis: `oldEntry + buybackCost` (the cost of closing the removed leg)
- Emit `LEG_OFF` event with `{ targetStrategy, closedLeg, keptLeg }` metadata (rebuild.ts replays from this)
- Keep position OPEN with updated legs/strategy

If detection fails, falls through to normal full-close. No regression.

### Also

Fix backtest timestamp guard (line 107): add LEG_OFF to `(action === 'CLOSE' || action === 'TRIM')`.

---

## Strategic: subsequent steps toward north star

### Step 2: recordTrade derives all actions from legs

Extend the leg-comparison logic to handle every case. The `action` parameter becomes optional/ignored — recordTrade figures it out:
- No existing position → OPEN
- Same-direction legs on existing → ADD
- Full reversal → CLOSE
- Partial qty reversal → TRIM
- Partial leg reversal → LEG_OFF (step 1)

The `action` param stays on the input type for backwards compat during migration but recordTrade stops reading it.

### Step 3: executor stops deriving action

Delete `deriveAction()`. The executor just needs `tradeId ? positionReducing : opening` for order building. Pass fills to recordTrade without an action label.

### Step 4: clean up the type surface

- Remove `action` from `RecordTradeInput`
- Remove `TradeAction` from executor/pipeline types
- `TradeAction` survives only in: parser routing, LLM schemas, event display, rebuild

---

## Files to modify (step 1 only)

| File | Change |
|---|---|
| `src/trades/record-trade.ts` | Leg comparison in CLOSE branch, timestamp guard fix |

## Verification

1. `npx tsc --noEmit`
2. `npx tsx scripts/eval-orchestrator.ts --case legoff-adv-008 && npx tsx scripts/eval-orchestrator.ts --case legoff-adv-009 && npx tsx scripts/eval-orchestrator.ts --case legoff-adv-010`
3. `npx tsx scripts/eval-orchestrator.ts` (full suite)
4. Re-run backtest: META trade shows LEG_OFF event, position mutates CDS→CALL, exit message finds open position
