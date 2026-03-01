# IBKR Order Lifecycle

> Complete state machine for TWS API order execution.
> Covers every status, transition, callback, and edge case.

---

## Order Status Values

Nine distinct values from the `orderStatus` callback.

| Status | Terminal? | Description |
|---|---|---|
| **ApiPending** | No | Not yet sent to IB server. Security definition delay. Rare. |
| **PendingSubmit** | No | Sent from TWS/Gateway, awaiting destination ack. |
| **PreSubmitted** | No | Simulated order (stop, stop-limit) held by IB until trigger. Also: child orders in brackets before parent fills. |
| **Submitted** | No | Working at exchange. Steady state for limit orders. |
| **PendingCancel** | No | Cancel request sent, awaiting confirmation. |
| **Filled** | **Yes** | Completely filled (`remaining == 0`). |
| **Cancelled** | **Yes** | Confirmed cancelled. Includes system cancellations. |
| **ApiCancelled** | **Yes** | Cancel was sent before IB acknowledged the order. |
| **Inactive** | **No** | Not working — held, rejected, or blocked. See triggers below. |

### Inactive Triggers

An `Inactive` status means the order exists but is NOT working:

1. **Regulatory reject** — order violates exchange rules
2. **Short sale locate pending** — shares being located (`whyHeld = "locate"`)
3. **Exchange closed** — order placed outside hours without valid TIF
4. **TWS precautionary block** — price/size exceeds user safety limits
5. **Account restriction** — insufficient permissions or margin
6. **IB internal hold** — compliance or risk holds

**An `error()` callback with a specific code ALWAYS accompanies Inactive.**

### Inactive Can Recover

Unlike `Cancelled`/`Filled`, Inactive is NOT always terminal:
- Short sell locate completes → transitions to `Submitted`
- Exchange reopens → transitions to `Submitted`
- TWS precautionary block manually accepted → transitions to `Submitted`

---

## State Machine

```
                    placeOrder()
                        |
                        v
                   [ApiPending] -----> (rare, security def delay)
                        |
                        v
                  [PendingSubmit]
                        |
              +---------+---------+
              |                   |
              v                   v
        [PreSubmitted]       [Submitted]
         (simulated           (native
          order held)          exchange)
              |                   |
              +----> [Submitted] -+
                        |
              +---------+---------+----------+
              |                   |          |
              v                   v          v
          [Filled]         [PendingCancel]  [Inactive]
         (TERMINAL)              |          (error/hold)
                                 |               |
                                 v               v
                           [Cancelled]      may recover to
                           (TERMINAL)       [Submitted] or
                                            stay [Cancelled]
```

### Transition Rules

```
ApiPending     → PendingSubmit
PendingSubmit  → PreSubmitted | Submitted | Inactive | Cancelled
PreSubmitted   → Submitted | Cancelled | Inactive
Submitted      → Filled | PendingCancel | Inactive | Cancelled
                 (also re-fires on each partial fill with updated counts)
PendingCancel  → Cancelled | Filled (race: fill beats cancel)
Inactive       → Submitted (hold released) | Cancelled (permanent reject)
Filled         → TERMINAL — nothing else.
Cancelled      → TERMINAL.
ApiCancelled   → TERMINAL.
```

---

## Critical Edge Cases

### 1. PendingCancel → Filled

If cancel request races with a fill at the exchange, **the fill wins**. You MUST handle `Filled` even after requesting cancel.

### 2. Duplicate orderStatus Messages

TWS explicitly warns these are common. Order handling must be **idempotent**.

### 3. Market Orders May Skip orderStatus

For instant-fill market orders, `orderStatus` callbacks may be **entirely absent**. `execDetails` is the only reliable fill notification in this case.

### 4. No Guaranteed Intermediate States

Market orders may go directly to `Filled` without `PendingSubmit` or `Submitted`.

---

## Partial Fills

There is **no `PartiallyFilled` status**. Status remains `Submitted` throughout.

Detect partial fills from `filled` and `remaining` parameters:

```
orderStatus(status="Submitted", filled=0,   remaining=100, avgFillPrice=0)
orderStatus(status="Submitted", filled=30,  remaining=70,  avgFillPrice=149.98)
orderStatus(status="Submitted", filled=30,  remaining=70,  avgFillPrice=149.98) ← DUPLICATE
orderStatus(status="Submitted", filled=80,  remaining=20,  avgFillPrice=149.99)
orderStatus(status="Filled",    filled=100, remaining=0,   avgFillPrice=150.00)
```

### Partial Fill + Cancellation

```
orderStatus(status="Submitted",     filled=30, remaining=70)
// cancelOrder() called
orderStatus(status="PendingCancel", filled=30, remaining=70)
orderStatus(status="Cancelled",     filled=30, remaining=70)
```

The final `Cancelled` status still carries `filled=30` — those shares were executed.

---

## Callback Sequence Per Fill

```
1. execDetails()                 — fill details (per execution)
2. orderStatus()                 — updated filled/remaining counts
3. openOrder()                   — updated order state
4. commissionAndFeesReport()     — commission for this fill
5. updatePortfolio()             — position change (if subscribed)
```

### execDetails vs orderStatus

| Callback | Fires on market order instant fill? | Per-fill details? | Cumulative counts? |
|---|---|---|---|
| `execDetails` | **Always** | Yes (`shares`, `price` per fill) | Yes (`cumQty`, `avgPrice`) |
| `orderStatus` | **Sometimes missing** | No | Yes (`filled`, `remaining`) |

**For correctness: always monitor both.**

---

## Combo/Spread (BAG) Orders

### Status Tracking

- Single `orderStatus` stream for the combo as a whole
- Individual legs do NOT get separate `orderStatus` callbacks

### Execution Reports

- Each leg fill generates its own `execDetails` and `commissionAndFeesReport`
- The `orderId` is the same across all legs (combo order ID)
- `Execution.side` may differ across legs (BUY/SELL for spread legs)

### Non-Guaranteed Combo Risk (SMART-routed)

With `NonGuaranteed=1`:
1. Each leg is routed independently
2. If leg A fills but leg B cannot → naked partial position
3. IB does NOT auto-unwind the filled leg
4. Combo status stays `Submitted` until all legs fill
5. Remaining unfilled legs stay open (GTC) until filled or cancelled

---

## Execution Corrections

If an exchange corrects a fill:
- A NEW `execDetails` fires with identical parameters except `execId`
- The corrected `execId` differs only in digits after the final period
- Example: `0001e0d1.654321.01.01` → correction `0001e0d1.654321.01.02`
- **You MUST detect this** or you will double-count fills

---

## Commission Reports

### CommissionAndFeesReport fields (TWS API 10.40+)

| Field | Type | Description |
|---|---|---|
| `execId` | String | Links to `Execution.execId` — the join key |
| `commissionAndFees` | double | Total. `Double.MAX_VALUE` = not yet available |
| `currency` | String | e.g., "USD" |
| `realizedPNL` | double | `Double.MAX_VALUE` if not applicable |

- One report per `execDetails` (1:1 via `execId`)
- Fires AFTER `execDetails`
- May be delayed — do not assume synchronous delivery
- On reconnection, today's commission reports are replayed

---

## Connection Loss & Recovery

### What Happens to Open Orders

| Order State | Survives API Disconnect? | Survives TWS Restart? |
|---|---|---|
| At exchange (Submitted) | Yes | Yes (exchange holds it) |
| Simulated (PreSubmitted) | Yes | **No** (TWS holds it) |
| PendingSubmit | Unknown state | Unknown |

### Recovery After Reconnect

1. Call `reqOpenOrders()` — get all active orders with current status
2. Call `reqExecutions(filter)` — get fills that occurred while disconnected (today only)
3. Compare against local state to detect missed fills
4. Commission reports for today's executions are also replayed

### Order ID Management

- `nextValidId` fires on connect with the next safe order ID
- Order IDs must be monotonically increasing within a session
- **`permId`** is permanent and account-wide — use it to correlate across reconnects

---

## Our Status Mapping (client.ts)

```typescript
function mapIbkrStatus(ibkrStatus: string): OrderStatus {
  switch (ibkrStatus) {
    case 'PreSubmitted':
    case 'Submitted':
      return 'PENDING';      // Working order
    case 'Filled':
      return 'FILLED';       // Terminal
    case 'Cancelled':
    case 'PendingCancel':
      return 'CANCELLED';    // Terminal (or nearly)
    case 'Inactive':
    case 'ApiCancelled':
      return 'REJECTED';     // Needs attention
    default:
      return 'PENDING';      // PendingSubmit, ApiPending
  }
}
```

**Gaps in current mapping:**
- `Inactive` maps to `REJECTED`, but Inactive can recover to `Submitted`
- `PendingCancel` maps to `CANCELLED`, but the order might still fill (race)
- No special handling for partial fills (same `PENDING` status)
