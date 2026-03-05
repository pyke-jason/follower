# Fix: Chase/Fill Desync in Backtest + Negative Price Floor

## Context

The backtest runner calls `broker.advanceTo(time)` (replays all ticks with the current limit), then `orderManager.tick(time)` (batch-applies all chase steps). This means chase adjustments never get evaluated against market ticks — the order limit is stale during tick replay, and by the time the chase runs, all ticks have already been consumed.

Verified with Databento ticks: NFLX 250912P01182500 had active bids ($0.82–$0.92) when the SELL limit was $1.11. After 2 chase steps the limit would reach $0.81 which is <= bid $0.90 — a fill. Instead, `advanceTo` evaluated all ticks at the stale $1.11, then `tick()` batch-dropped the limit to $-1.89 with no ticks left to re-evaluate. Affects 8 of 89 trades (~9%) in the test backtest.

## Plan

### Step 1: Add `advanceWithChaseInterleaving` helper to runner.ts

New function in `src/backtest/runner.ts` that replaces the sequential `advanceTo` + `tick` pattern:

```typescript
async function advanceWithChaseInterleaving(
  broker: SimBroker,
  orderManager: OrderManager,
  from: Date,
  to: Date,
): Promise<void> {
  // Fast path: no active chase orders — single advance
  const workingOrders = orderManager.getWorkingOrders();
  const hasChaseRules = workingOrders.some(wo =>
    wo.status === 'OPEN' &&
    wo.params.adjustmentRules?.some(r => r.type === 'PRICE_CHASE')
  );

  if (!hasChaseRules) {
    await broker.advanceTo(to);
    await orderManager.tick(to);
    return;
  }

  // Find minimum chase interval across all active orders
  let minIntervalMs = Infinity;
  for (const wo of workingOrders) {
    if (wo.status !== 'OPEN') continue;
    for (const rule of (wo.params.adjustmentRules ?? [])) {
      if (rule.type === 'PRICE_CHASE') {
        minIntervalMs = Math.min(minIntervalMs, rule.intervalSec * 1000);
      }
    }
  }

  // Sub-step through time at chase intervals
  let t = from.getTime();
  const target = to.getTime();

  while (t < target) {
    const nextT = Math.min(t + minIntervalMs, target);
    const nextDate = new Date(nextT);

    await broker.advanceTo(nextDate);   // ticks in [lastAdvance, nextDate]
    await orderManager.tick(nextDate);  // applies 1 chase step, updates limit

    t = nextT;

    // Early exit: all chase orders resolved (filled/cancelled)
    const remaining = orderManager.getWorkingOrders()
      .filter(wo => wo.status === 'OPEN' &&
        wo.params.adjustmentRules?.some(r => r.type === 'PRICE_CHASE'));
    if (remaining.length === 0) {
      if (nextT < target) {
        await broker.advanceTo(to);
        await orderManager.tick(to);
      }
      break;
    }
  }
}
```

### Step 2: Replace 2 call sites in runner.ts

**Day boundary** (lines 277–278):
```typescript
// Before:
await broker.advanceTo(prevDayClose);
await orderManager.tick(prevDayClose);

// After:
await advanceWithChaseInterleaving(broker, orderManager, clock.now(), prevDayClose);
```

**Per-message** (lines 346–348):
```typescript
// Before:
clock.advance(msg.timestamp);
await broker.advanceTo(msg.timestamp);
await orderManager.tick(msg.timestamp);

// After:
const prevSimTime = clock.now();
clock.advance(msg.timestamp);
await advanceWithChaseInterleaving(broker, orderManager, prevSimTime, msg.timestamp);
```

Leave `orderManager.tick(clock.now())` at line 302 unchanged — that's just detecting cancelled orders after day boundary cancel logic.

### Step 3: Add price floor in order-manager.ts

`src/orders/order-manager.ts:155–157` — safety net even with interleaving:

```typescript
// Before:
const roundedPrice = roundCents(newPrice);

// After:
const roundedPrice = roundCents(Math.max(0.01, newPrice));
```

### Step 4: Scratchpad verification

Create `scratchpad/verify-chase-fix.ts` that:

1. Reads NFLX 250912P01182500 ticks from tick-cache.db
2. Creates a mock broker that implements the fill logic (`shouldFillLimit`, `modifyOrder`, tick replay)
3. Creates a real `OrderManager` with PUT close chase rules (step=$0.15, interval=5s, maxSteps=20)
4. **Test A (OLD behavior)**: single `advanceTo` then `tick` → verify NO fill, limit = $-1.89
5. **Test B (NEW behavior)**: `advanceWithChaseInterleaving` → verify FILL at ~$0.90 via price improvement
6. **Test C (price floor)**: verify limit never goes below $0.01

Delete scratchpad after verification passes.

### Step 5: Run existing tests

```
npx vitest run src/orders/order-manager.test.ts
npx vitest run src/backtest/sim-broker-temporal.test.ts
```

Ensure no regressions.

## Files Modified

| File | Change |
|---|---|
| `src/backtest/runner.ts` | Add `advanceWithChaseInterleaving`, replace 2 call sites |
| `src/orders/order-manager.ts:155` | Add `Math.max(0.01, newPrice)` price floor |
| `scratchpad/verify-chase-fix.ts` | Create → verify → delete |

## Performance

For the NFLX case: 17 min / 5s interval = 204 sub-steps. Each sub-step's `advanceTo` processes 0–2 ticks (tick-cache queries are cached). Current: 1 call × ~30 ticks. New: ~204 calls × ~0.15 ticks avg. Same total tick processing, more method calls — negligible overhead.

Fast path (no chase orders) is zero-cost — same as current behavior.

## Not In Scope

- Auto-close price accuracy (the $1.11 vs $0.98 discrepancy) — separate investigation
- Duplicate close race in live mode — latent bug, separate fix
- Proportional chase amounts for cheap options — enhancement, not a fix
