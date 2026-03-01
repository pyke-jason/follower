# Sidecar Implementation Details

Implementation-specific behavior for our Java sidecar and TS client.
For official IBKR TWS API behavior, see [`../ibkr/`](../ibkr/).

---

## TWS Error Code Handling

### What the sidecar broadcasts via WebSocket

12 order-related error codes -> WS `error` event:

**110, 200, 201, 202, 203, 392, 399, 404, 412, 426, 460, 10239**

(`TwsBridge.java:33-34` -- `ORDER_ERROR_CODES` set)

**Note on error 460:** This code is NOT in the official TWS API message codes documentation. It may be a TWS-internal code delivered at runtime. We observe and handle it but it has no official documentation.

**Note on error 426:** The official meaning is "None of the accounts have enough shares" (FA allocation context). We classify it as "Cash account cannot short" which is a narrower interpretation. For our single-account use case this is fine, but the official meaning is broader.

### TS client handling (ws-listener.ts)

| Severity | Codes | Action |
|---|---|---|
| **critical** | 460, 10239 | `sendSystemAlert` critical |
| **warning** | 200, 201, 203, 392, 399, 404, 412, 426 | `sendSystemAlert` warning |
| **log** | 202 (cancelled by IB), 110 (tick size) | Log at info level |

### What the sidecar drops

- `advancedOrderRejectJson` (5th error param) -- completely ignored. Contains FIX Tag 8230/8229 override details.
- All error codes not in `ORDER_ERROR_CODES` -- logged server-side, not broadcast via WS.
- `whyHeld` and `mktCapPrice` from order status events -- not forwarded.

---

## Status Mapping (client.ts)

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

### Known Gaps in Current Mapping

1. **`Inactive` maps to `REJECTED`**, but Inactive can recover to `Submitted` (see [`../ibkr/order-lifecycle.md`](../ibkr/order-lifecycle.md#inactive-can-recover))
2. **`PendingCancel` maps to `CANCELLED`**, but the order might still fill (race condition)
3. **No special handling for partial fills** (same `PENDING` status whether filled=0 or filled=80)

---

## Informational Error Handling

Codes logged silently (debug level, not broadcast):

| Code | Meaning |
|---|---|
| 2104 | Market data farm connection OK |
| 2106 | HMDS data farm connection OK |
| 2158 | Sec-def data farm connection OK |

### NOT handled (should be)

| Code | Meaning | Why It Matters |
|---|---|---|
| 2100 | Account subscription preempted | Another client took over `reqAccountUpdates`. Our warm path for account summary silently breaks. |
| 326 | Client ID already in use | Reconnect will fail. Need to detect and retry with different ID or wait. |

---

## Connection Error Handling

| Code | Meaning | Sidecar Action |
|---|---|---|
| 1100 | Connectivity lost | `connected=false`, WS `disconnected`, start reconnect thread |
| 504 | Not connected | `connected=false`, WS `disconnected`, start reconnect thread |
| 1101 | Restored (data lost) | `connected=true`, WS `reconnected` |
| 1102 | Restored (data maintained) | `connected=true`, WS `reconnected` |

### NOT handled (should be)

| Code | Action Needed |
|---|---|
| 507 | Should trigger `connected=false` + reconnect (currently not handled) |
| 1300 | Should trigger full reconnect (currently not handled) |

### After Reconnect (NOT implemented)

The sidecar does NOT currently:
- Call `reqOpenOrders()` to reconcile open order state
- Call `reqExecutions()` to get missed fills
- Re-subscribe to market data after error 1101

---

## Account Summary Implementation

### Cold-start path (`reqAccountSummary`)

Tags requested (`AccountRoutes.java:23-24`):
```
"NetLiquidation,AvailableFunds,MaintMarginReq,UnrealizedPnL"
```
Returns only these 4 fields. Missing: Cushion, ExcessLiquidity, SMA, etc.

**Note:** `reqAccountSummary` is actually a subscription (not one-shot as the code implies). It should be cancelled via `cancelAccountSummary()` when no longer needed.

### Warm path (`reqAccountUpdates` subscription)

Once the subscription activates, the `/api/account/summary` endpoint reads from the `accountValues` map. Returns 8 fields:

```
NetLiquidation, AvailableFunds, MaintMarginReq, UnrealizedPnL,
Cushion, SMA-S, DayTradesRemaining, ExcessLiquidity-S
```

TWS sends values with segment suffixes (`SMA-S` = securities, `ExcessLiquidity-S` = securities). The REST response maps these to `sma` and `excessLiquidity` (camelCase, no suffix).

### Still missing from either path

```
FullMaintMarginReq, BuyingPower, LookAheadNextChange,
LookAheadMaintMarginReq, LookAheadExcessLiquidity
```

Available via the subscription but not yet exposed in the REST response.

---

## Auto-Reconnect Implementation

- Thread `"reconnect-scheduler"` spawns on disconnect
- 5s fixed delay between attempts (no exponential backoff)
- Defers during maintenance window (sleeps 60s, rechecks)
- Stops when `connected=true` or `shuttingDown=true`

### Known Issues

1. **`isConnected()` lies** -- returns `true` after socket death until `eDisconnect()` called (see [`../ibkr/connection.md`](../ibkr/connection.md#isconnected-behavior))
2. **EReader thread can zombie** -- `waitForSignal()` blocks if socket breaks without clean exception
3. **No `+PACEAPI`** -- not called before `eConnect()`, so rate limit violations cause disconnect instead of throttling
4. **No heartbeat watchdog** -- zombie connections (half-open sockets) go undetected
5. **No state reconciliation after reconnect** -- `reqOpenOrders()` and `reqExecutions()` not called
6. **Competing session risk** -- if Client Portal is logged in with same username, auto-reconnect silently fails after next nightly reset
