# IBKR Migration Plan — Adapted for Trade Follower 3

> Adapted from generic IBKR brief. Audited against the actual codebase structure,
> BrokerService interface, pipeline architecture, and alerting systems.

---

## 0. What Changes, What Doesn't

**CHANGES:**
- `src/broker/tradestation/` → `src/broker/ibkr/` (new BrokerService implementation)
- New Java sidecar process (`sidecar/`) exposing REST + WebSocket on localhost
- IB Gateway + IBC setup on macOS (launchd, same pattern as existing daemon)
- Option symbology: TradeStation format → OCC format (IBKR uses OCC natively — simpler)
- Combo/spread orders: TradeStation handles legs server-side → IBKR needs BAG contracts via sidecar

**DOES NOT CHANGE:**
- `BrokerService` interface (`src/broker/interface.ts`) — IBKR client implements this
- Pipeline: parser → orchestrator → execute-resolved → record-trade
- `OrderManager` (price-chase, auto-cancel, fill polling) — works on any BrokerService
- Position tracking (DB-based, not broker-based)
- Reconciliation layer (already broker-agnostic via `BrokerService.getPositions()`)
- `FillSweep` (already broker-agnostic via `BrokerService.getOrderStatus()`)
- Signal ingestion (OneOption chat via Playwright/SignalR)
- Alerts: Discord webhooks (`sendSystemAlert`) + Pushover (critical)
- Position sizing, risk checks, spread midpoint pricing
- Web frontend, local API, backtest infrastructure
- SimBroker (backtesting)

**KEY INSIGHT:** The existing `BrokerService` interface is the right abstraction boundary.
Everything above it (pipeline, orders, reconciliation) is broker-agnostic. The migration
is scoped to: (1) build the Java sidecar, (2) build `src/broker/ibkr/client.ts` that
talks to the sidecar and implements `BrokerService`, (3) wire up the live runner to
use the new implementation.

---

## 1. Architecture

```
┌─ macOS (same machine as existing Trade Follower 3) ──────────────┐
│                                                                   │
│  IB Gateway (Java app, managed by IBC)                            │
│    - TWS binary protocol on localhost:4001 (live) / 4002 (paper)  │
│    - Weekly 2FA via IBKR Mobile (Sunday after 01:00 ET)           │
│    - Daily restart at 01:00 ET (no re-auth needed same day)       │
│    - Maintenance blackout: 00:15–01:45 ET daily                   │
│                                                                   │
│  Java Sidecar (Javalin, ~500 lines)                               │
│    - Uses official TwsApi.jar (IBKR's Java client)                │
│    - Connects to IB Gateway on localhost:4001                     │
│    - Exposes REST on localhost:8090 (NOT 8080, avoids conflicts)  │
│    - Exposes WebSocket on ws://localhost:8090/events              │
│    - Translates: REST → TWS API call → callback → response/push  │
│    - Auto-reconnects to Gateway on disconnect                     │
│                                                                   │
│  Trade Follower 3 (existing Node.js process)                      │
│    - src/broker/ibkr/client.ts implements BrokerService           │
│    - Calls sidecar REST for getQuote/placeOrder/etc.              │
│    - Listens to sidecar WebSocket for fills and connection events │
│    - ALL existing pipeline/orders/reconciliation code unchanged   │
│    - Alerts via Discord webhook + Pushover (existing system)      │
│    - Runs as launchd service (existing com.tradefollower.agent)   │
│                                                                   │
│  Watchdog (cron / launchd)                                        │
│    - Health checks sidecar + Trade Follower process               │
│    - Sunday 2FA reminder via Pushover (not Telegram)              │
└───────────────────────────────────────────────────────────────────┘
```

### Process Lifecycle (integrated with existing daemon)

1. **macOS boot/login** → launchd starts IBC → IBC starts IB Gateway → auto-login
2. **Java sidecar starts** (separate launchd plist) → connects to Gateway → waits for `nextValidId`
3. **Trade Follower starts** (existing `com.tradefollower.agent` plist) → `src/index.ts:main()` initializes IBKR client → connects to sidecar REST + WS
4. **Daily ~01:00 ET** → Gateway auto-restarts → sidecar reconnects → pushes `reconnected` WS event → IBKR client receives event, logs info, no action needed (OrderManager already polls)
5. **Sunday 01:00 ET** → weekly cold restart → 2FA via IBKR Mobile → IBC completes login → sidecar reconnects. **Pushover alert** sent via existing `sendPushover()` as 2FA reminder.
6. **00:15–01:45 ET daily** → sidecar returns 503 → IBKR client maps to transient error → existing retry logic handles it

---

## 2. Java Sidecar — Spec

### Location in Monorepo

```
trade-follower-3/
├── sidecar/                          # NEW — Java sidecar
│   ├── build.gradle.kts
│   ├── lib/
│   │   └── TwsApi.jar               # Official IBKR Java client (NOT on Maven Central)
│   ├── src/main/java/com/tradefollower/sidecar/
│   │   ├── App.java                  # Javalin HTTP server setup
│   │   ├── TwsBridge.java           # EWrapper impl, connection mgmt
│   │   ├── ContractRoutes.java      # /api/contracts/* endpoints
│   │   ├── OrderRoutes.java         # /api/orders/* endpoints
│   │   ├── AccountRoutes.java       # /api/account/*, /api/positions
│   │   ├── MarketDataRoutes.java    # /api/market-data/* endpoints
│   │   └── WsHandler.java           # WebSocket event broadcasting
│   └── scripts/
│       └── start-sidecar.sh
├── src/                              # Existing
│   ├── lib/
│   │   ├── occ-symbology.ts          # MOVED from src/backtest/ (Phase 0.1)
│   │   ├── resilient.ts              # UPDATED: exports classifyError (Phase 0.3)
│   │   ├── trade.ts                  # UPDATED: + getSpreadWidth (Phase 0.4)
│   │   ├── alert.ts                  # Unchanged — Discord + Pushover alerts
│   │   └── ...
│   ├── broker/
│   │   ├── interface.ts              # BrokerService — unchanged
│   │   ├── types.ts                  # Broker types — unchanged
│   │   ├── order-schemas.ts          # Zod validation — unchanged
│   │   ├── tradestation/             # KEPT (for reference/rollback)
│   │   │   └── ...                   # client.ts UPDATED: uses shared classifyError
│   │   └── ibkr/                     # NEW
│   │       ├── client.ts             # BrokerService implementation
│   │       ├── ws-listener.ts        # WebSocket event consumer
│   │       ├── symbology.ts          # conId resolution (imports from lib/occ-symbology)
│   │       ├── schemas.ts            # Zod schemas for sidecar API responses
│   │       └── index.ts              # Exports ibkrService
│   └── ...
```

### REST API (sidecar exposes on localhost:8090)

These endpoints map 1:1 to `BrokerService` methods.

#### Connection / Health

```
GET /api/status
    → { "connected": true, "accountId": "U1234567", "serverVersion": 176 }
```

Maps to: startup health check in `src/broker/ibkr/client.ts`

#### Quotes (maps to `BrokerService.getQuote`)

```
POST /api/market-data/snapshot
     Body: { "symbol": "SPY", "secType": "STK" }
     → { "symbol": "SPY", "bid": 580.10, "ask": 580.15, "last": 580.12, "volume": 1234567 }

POST /api/market-data/snapshot
     Body: { "conId": 123456 }
     → { "symbol": "SPY 260320P00580000", "bid": 2.45, "ask": 2.50, "last": 2.47, "volume": 1234 }
```

**For options:** The IBKR client resolves conId first via `/api/contracts/resolve`, then requests snapshot. This is internal to the `getQuote` implementation — the `BrokerService` consumer still calls `getQuote("SPY 260320P00580000")` with an OCC symbol.

#### Contract Resolution (internal to IBKR client, not in BrokerService)

```
POST /api/contracts/resolve
     Body: { "symbol": "SPY", "secType": "OPT", "expiry": "20260320",
             "strike": 580.0, "right": "P", "exchange": "SMART", "currency": "USD" }
     → { "conId": 123456789, "localSymbol": "SPY   260320P00580000",
         "multiplier": "100", "exchange": "SMART" }
```

Used by `symbology.ts` to convert OCC symbols to IBKR conIds. Results cached in-memory (conIds don't change).

#### Orders (maps to `BrokerService.placeOrder/modifyOrder/cancelOrder/getOrderStatus`)

```
POST /api/orders/single
     Body: { "conId": 123456, "action": "BUY", "orderType": "LMT",
             "limitPrice": 2.50, "quantity": 5, "tif": "GTC" }
     → { "orderId": 42, "status": "PreSubmitted" }

POST /api/orders/combo
     Body: {
       "symbol": "SPY",
       "legs": [
         { "conId": 123456, "ratio": 1, "action": "SELL", "exchange": "SMART" },
         { "conId": 789012, "ratio": 1, "action": "BUY",  "exchange": "SMART" }
       ],
       "action": "BUY",
       "orderType": "LMT",
       "limitPrice": 0.50,
       "quantity": 1,
       "tif": "GTC",
       "nonGuaranteed": true
     }
     → { "orderId": 42, "status": "PreSubmitted" }

PUT /api/orders/:orderId
    Body: { "limitPrice": 0.55 }
    → { "orderId": 42, "status": "PreSubmitted" }

DELETE /api/orders/:orderId
    → { "status": "PendingCancel" }

GET /api/orders/:orderId
    → { "orderId": 42, "status": "Filled", "filledQuantity": 1,
        "avgFillPrice": 0.48, "commission": 1.30 }
```

#### Positions (maps to `BrokerService.getPositions`)

```
GET /api/positions
    → [{ "conId": 123456, "symbol": "SPY", "secType": "OPT",
         "localSymbol": "SPY   260320P00580000", "position": -5,
         "avgCost": 2.30, "marketValue": -1150, "unrealizedPnl": 50 }]
```

**NOTE:** IBKR returns individual legs, not grouped spreads. This is fine — the reconciliation
layer (`src/reconciliation/reconciler.ts`) already compares at the individual position level.

#### Account (maps to `BrokerService.getAccountBalance`)

```
GET /api/account/summary
    → { "netLiquidation": 150000, "availableFunds": 80000,
        "maintenanceMargin": 12000, "unrealizedPnl": -340 }
```

### WebSocket Events (sidecar → Trade Follower)

```typescript
// src/broker/ibkr/ws-listener.ts consumes these events:
type SidecarEvent =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "reconnected" }
  | { type: "orderStatus"; orderId: number; status: string; filled: number;
      remaining: number; avgFillPrice: number }
  | { type: "error"; code: number; message: string; orderId?: number }
```

**Integration with OrderManager:** The WebSocket listener is supplementary. The existing
`OrderManager` already polls `broker.getOrderStatus()` every 1 second. The WS events
provide faster fill notification but are NOT required for correctness. On `orderStatus`
with status `Filled`, the listener can call `orderManager.forceCheck(orderId)` to trigger
an immediate status poll rather than waiting for the next tick.

**Integration with alerts:** On `disconnected` → `sendSystemAlert({ severity: 'warning', title: 'IBKR sidecar disconnected' })`. On `error` with code 460 (margin exceeded) → `sendSystemAlert({ severity: 'critical', title: 'IBKR margin exceeded' })` which auto-triggers Pushover.

---

## 3. BrokerService Implementation — `src/broker/ibkr/client.ts`

The IBKR client implements the existing interface. No interface changes needed.

```typescript
// src/broker/ibkr/client.ts — implements BrokerService

import type { BrokerService, Quote, OrderParams, OrderResult,
              BrokerPosition, AccountBalance } from '../interface';

const SIDECAR_URL = process.env.IBKR_SIDECAR_URL ?? 'http://localhost:8090/api';

export const ibkrService: BrokerService = {
  async getQuote(symbol: string): Promise<Quote> {
    // 1. Parse OCC symbol → { underlying, expiry, right, strike } or detect stock
    // 2. Resolve conId via POST /api/contracts/resolve (cached)
    // 3. GET /api/market-data/snapshot with conId
    // 4. Map response to Quote type: { symbol, bid, ask, last, volume, timestamp }
  },

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    // 1. For each leg: resolve conId via symbology.ts
    // 2. If single leg: POST /api/orders/single
    //    If multi-leg (CDS/PDS): POST /api/orders/combo with BAG contract
    // 3. Map IBKR status → OrderStatus enum:
    //    PreSubmitted/Submitted → PENDING
    //    Filled → FILLED
    //    Cancelled → CANCELLED
    //    Inactive/ApiCancelled → REJECTED
    // 4. Return OrderResult
  },

  async modifyOrder(orderId: string, newLimitPrice: number): Promise<OrderResult> {
    // PUT /api/orders/:orderId with { limitPrice: roundToOptionTick(newLimitPrice) }
    // Map response to OrderResult
  },

  async cancelOrder(orderId: string): Promise<OrderResult> {
    // DELETE /api/orders/:orderId
    // Map response to OrderResult
  },

  async getOrderStatus(orderId: string): Promise<OrderResult> {
    // GET /api/orders/:orderId
    // Map response to OrderResult
    // Include filledPrice, filledQuantity, commission, fillTimestamp when filled
  },

  async getPositions(): Promise<BrokerPosition[]> {
    // GET /api/positions
    // Map each IBKR position to BrokerPosition type
    // IBKR returns individual legs — reconciler handles grouping
  },

  async getAccountBalance(): Promise<AccountBalance> {
    // GET /api/account/summary
    // Map: netLiquidation → equity, availableFunds → buyingPower, etc.
  },
};
```

### Symbology — `src/broker/ibkr/symbology.ts`

IBKR uses OCC format natively (`SPY   260320P00580000`), which is also the internal
format used by the orchestrator and Databento. This is simpler than TradeStation's
custom format.

```typescript
// Parse OCC symbol → contract params for sidecar resolve endpoint
export function occToIBKR(occSymbol: string): {
  symbol: string; secType: 'OPT'; expiry: string;
  strike: number; right: 'C' | 'P';
}

// Cache: OCC symbol → conId (conIds are stable, cache indefinitely)
const conIdCache = new Map<string, number>();

export async function resolveConId(occSymbol: string): Promise<number>
```

**vs. TradeStation symbology:** The existing `src/broker/tradestation/symbology.ts` converts
OCC → TradeStation format (`SPY 260320P580`). For IBKR we skip format conversion entirely
and just extract the OCC fields to resolve a conId. Simpler.

### Option Tick Size Rounding

The sidecar handles tick size validation and rounding before sending to Gateway:
- Below $3.00: $0.01 increments
- At/above $3.00: $0.05 increments
- Exception: Penny Pilot symbols (SPY, QQQ, AAPL, etc.) use $0.01 for all prices

The IBKR client should also round locally in `placeOrder` and `modifyOrder` to avoid
unnecessary sidecar round-trips that would fail. Use a `roundToOptionTick(symbol, price)`
helper — similar to how the existing executor already handles price stepping.

### Error Classification

Map to the same error categories used by TradeStation's `tsClassify`:

| IBKR Error | Classification | Action |
|---|---|---|
| Sidecar 503 (maintenance) | `transient` | Retry with backoff |
| Sidecar unreachable | `transient` | Retry with backoff |
| Error 504 (not connected) | `transient` | Wait for reconnect |
| Error 1100 (connectivity lost) | `transient` | Wait for reconnect |
| Error 110 (tick size) | `permanent` | Should not happen (pre-rounded) |
| Error 201 (order rejected) | `permanent` | Surface via OrderResult.status = REJECTED |
| Error 460 (margin exceeded) | `permanent` | REJECTED + critical alert |
| Error 422 (invalid contract) | `permanent` | Maps to QuoteResolutionError (existing retry-LLM flow) |

**NOTE:** The existing retry and error handling in `execute-resolved.ts` already handles
`QuoteResolutionError` with the LLM retry path. IBKR 422s on bad symbols will naturally
flow through the same mechanism.

---

## 4. What the Sidecar Must Handle (IBKR-Specific Concerns)

### 4.1 Combo/Spread Orders (BAG Contracts)

The existing pipeline sends `OrderParams` with multiple `legs[]`. For TradeStation, the
client posts all legs in a single order request and TS handles the combo. For IBKR:

1. IBKR client resolves each leg to a conId
2. Builds a BAG contract with ComboLegs
3. Posts to sidecar's `/api/orders/combo` endpoint
4. Sidecar constructs the BAG Contract + Order objects and calls `client.placeOrder()`

**Critical:** `smartComboRoutingParams` with `NonGuaranteed: "1"` is REQUIRED for
all SMART-routed combo orders. The sidecar enforces this — the TS client just passes
`nonGuaranteed: true` in the request body.

**Critical:** NEVER use `OrderType.MKT` for combos. The existing pipeline already
enforces LIMIT for all non-stock orders (`execute-resolved.ts` throws if limitPrice
is undefined for options). This constraint is naturally preserved.

### 4.2 Maintenance Window (00:15–01:45 ET)

The sidecar rejects orders during maintenance with HTTP 503. The IBKR client maps this
to a transient error. The existing OrderManager doesn't place orders during this window
because no signals arrive at that hour. But as defense-in-depth:

- IBKR client logs a warning on 503 maintenance response
- The sidecar includes `retryAfter` in the 503 response body
- If an order is somehow attempted during maintenance, it fails gracefully through
  existing error handling (no special code needed in pipeline)

### 4.3 EReader Thread (Java-Side Critical)

The sidecar MUST correctly implement the EReader thread pattern:

```java
EReader reader = new EReader(client, signal);
reader.start();
new Thread(() -> {
    while (client.isConnected()) {
        signal.waitForSignal();
        reader.processMsgs();
    }
}).start();
```

Without this, ZERO callbacks fire. This is the #1 Java TWS API mistake. The sidecar
must have integration tests that verify callbacks fire after connection.

### 4.4 Position Reconstruction

IBKR does NOT return combo positions as combos — it returns individual option legs.
This is fine for Trade Follower because:

- **Internal position tracking** is DB-based (`trades` table), not broker-based
- **Reconciliation** (`src/reconciliation/reconciler.ts`) already compares individual
  positions (symbol + quantity), not grouped spreads
- The `BrokerPosition` type already models individual positions

No spread reconstruction logic is needed in the IBKR client.

### 4.5 Request → Response Mapping (Async TWS → Sync REST)

The sidecar bridges TWS's async callback API to synchronous REST:

1. Generate a `reqId` (atomic integer)
2. Create `CompletableFuture` in `ConcurrentHashMap<Integer, CompletableFuture<?>>`
3. Call TWS API method (e.g., `client.reqContractDetails(reqId, contract)`)
4. REST endpoint calls `future.get(5, TimeUnit.SECONDS)` to block
5. EWrapper callback fires, completes the future

Timeout = 5 seconds for all request types. On timeout → HTTP 504 to TS client.

### 4.6 Daily Restart / Reconnection

IB Gateway auto-restarts daily at ~01:00 ET. The sidecar:

1. Detects disconnect via `connectionClosed()` callback
2. Pushes `{ type: "disconnected" }` on WebSocket
3. Schedules reconnect with 5-second retry, skipping maintenance window
4. On successful reconnect, pushes `{ type: "reconnected" }`

The IBKR client in Node.js receives the WS events and:
- On `disconnected`: `sendSystemAlert({ severity: 'warning', title: 'IBKR Gateway disconnected' })`
- On `reconnected`: `sendSystemAlert({ severity: 'info', title: 'IBKR Gateway reconnected' })`
- Between disconnect/reconnect: `getQuote`/`placeOrder` calls fail with transient error → OrderManager's poll naturally pauses

### 4.7 TWS Error Code Handling (Sidecar Responsibility)

**Informational (log, don't push):**
- 2104, 2106, 2158 — data farm connections OK

**Connection (reconnect + push WS event):**
- 1100 — connectivity lost
- 1101/1102 — connectivity restored
- 504 — not connected

**Order errors (push as WS event + return in REST response):**
- 110 — tick size violation (should be prevented by pre-rounding)
- 201 — order rejected → OrderResult.status = REJECTED
- 202 — order cancelled → OrderResult.status = CANCELLED
- 460 — margin exceeded → REJECTED + sidecar includes error detail

---

## 5. Integration with Existing Systems

### 5.1 Live Runner (`src/live/runner.ts`)

Currently creates `liveService` from TradeStation. Change to:

```typescript
// src/live/factory.ts or runner.ts — swap broker implementation
import { ibkrService } from '../broker/ibkr';
// Replace: import { liveService } from '../broker/tradestation';

// The rest of the runner is unchanged — it only uses BrokerService
```

Use an env var (`BROKER=ibkr|tradestation`) to select implementation during transition.

### 5.2 OrderManager (`src/orders/order-manager.ts`)

**No changes needed.** The OrderManager:
- Calls `broker.placeOrder()` — works with any BrokerService
- Calls `broker.getOrderStatus()` every 1 second — works with any BrokerService
- Calls `broker.modifyOrder()` for price-chase — works with any BrokerService
- Calls `broker.cancelOrder()` for auto-cancel — works with any BrokerService

The IBKR WebSocket listener can optionally notify OrderManager of fills for faster
response, but correctness doesn't depend on it.

### 5.3 Reconciliation (`src/reconciliation/`)

**No changes needed.** The reconciler:
- Calls `broker.getPositions()` — the IBKR client implements this
- Compares with DB `trades` table — unchanged
- Sends alerts via `sendDiscordAlert()` + `sendPushover()` — unchanged

### 5.4 Fill Sweep (`src/reconciliation/fill-sweep.ts`)

**No changes needed.** It calls `broker.getOrderStatus()` — the IBKR client implements this.

### 5.5 Spread Midpoint (`src/pipeline/spread-midpoint.ts`)

**No changes needed.** It calls `broker.getQuote()` for each leg — the IBKR client implements this.

### 5.6 Position Sizing (`src/position-sizing/index.ts`)

**No changes needed.** It calls `broker.getAccountBalance()` — the IBKR client implements this.

### 5.7 Alerts

All alerts continue to use the existing `sendSystemAlert()` from `src/lib/alert.ts`:
- Discord webhook embeds with severity color coding
- Pushover emergency push for `severity: 'critical'`

New IBKR-specific alerts to add:

| Event | Severity | Discord | Pushover |
|---|---|---|---|
| Sidecar disconnected | warning | Yes | No |
| Sidecar reconnected | info | Yes | No |
| Margin exceeded (error 460) | critical | Yes | Yes |
| Order rejected (error 201) | warning | Yes | No |
| Sunday 2FA reminder (cron) | critical | Yes | Yes |
| Sidecar unreachable for > 60s | critical | Yes | Yes |

### 5.8 Backtest (SimBroker)

**No changes.** SimBroker is a separate BrokerService implementation used only for backtesting.
It has no connection to any live broker.

---

## 6. Environment Variables

Add to `.env` (managed via existing secrets layer):

```bash
# Broker selection
BROKER=ibkr                              # or 'tradestation' for rollback

# IBKR Sidecar
IBKR_SIDECAR_URL=http://localhost:8090   # REST base
IBKR_SIDECAR_WS=ws://localhost:8090/events  # WebSocket

# IBKR Account (used by sidecar, not TS bot)
IBKR_ACCOUNT_ID=U1234567                 # For sidecar account queries
IBKR_GATEWAY_PORT=4001                   # Live: 4001, Paper: 4002

# Keep existing TradeStation vars for rollback period
# TS_CLIENT_ID, TS_CLIENT_SECRET, TS_REFRESH_TOKEN, TS_ACCOUNT_ID
```

---

## 7. IB Gateway + IBC macOS Setup

### Install (one-time manual steps)

1. **IB Gateway** — https://www.interactivebrokers.com/en/trading/ibgateway-latest.php
   - Installs to `/Applications/IB Gateway 10.XX.app`
   - Requires IBKR Pro account

2. **IBC** — https://github.com/IbcAlpha/IBC/releases/latest
   - Extract to `/opt/ibc/`

3. **IBC config.ini** — `/opt/ibc/config.ini`:
```ini
IbLoginId=YOUR_USERNAME
IbPassword=YOUR_PASSWORD
SecondFactorAuthenticationExitInterval=60
ReloginAfterSecondFactorAuthenticationTimeout=yes
AutoRestartTime=01:00
ExistingSessionDetectedAction=secondary
AcceptIncomingConnectionAction=accept
ReadOnlyLogin=no
DismissPasswordExpiryWarning=yes
DismissNSEComplianceNotice=yes
AcceptNonBrokerageAccountWarning=yes
```

4. **Session collision prevention**: Create a second IBKR username (Account Management →
   Users & Access Rights). Use one for Gateway API, one for manual phone/web access.

5. **Prevent Mac sleep**: System Settings → Energy → "Prevent automatic sleeping when
   display is off" ON. (Already configured for existing Trade Follower daemon.)

### launchd plists

**IB Gateway** — `~/Library/LaunchAgents/local.ibc-gateway.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>local.ibc-gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/ibc/scripts/ibcstart.sh</string>
        <string>-g</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
    <key>StandardErrorPath</key><string>/tmp/ibc-gateway.err</string>
    <key>StandardOutPath</key><string>/tmp/ibc-gateway.log</string>
</dict>
</plist>
```

**Java Sidecar** — `~/Library/LaunchAgents/com.tradefollower.ibkr-sidecar.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.tradefollower.ibkr-sidecar</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/java</string>
        <string>-jar</string>
        <string>/Users/jason/trade-follower-3/sidecar/build/libs/sidecar.jar</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardErrorPath</key><string>/Users/jason/trade-follower-3/.logs/sidecar.err</string>
    <key>StandardOutPath</key><string>/Users/jason/trade-follower-3/.logs/sidecar.log</string>
    <key>WorkingDirectory</key><string>/Users/jason/trade-follower-3/sidecar</string>
</dict>
</plist>
```

---

## 8. Implementation Phases

### Phase 0: Code Extractions (prerequisite — unblocks Phase 2)

Extract general-purpose code currently buried in module-specific directories so the
IBKR client (and future broker implementations) can import shared utilities cleanly.

**0.1 — OCC symbology: `src/backtest/occ-symbology.ts` → `src/lib/occ-symbology.ts`**

Move the entire file. Contains `formatOccSymbol`, `parseOccSymbol`, `isOccOptionSymbol`,
`buildOccSymbols`, `normalizeExpiry`, `inferATMStrike/Spread` — all pure functions with
zero backtest dependencies. Currently imported across module boundaries:
- `src/pipeline/execute-resolved.ts` imports from `../backtest/occ-symbology`
- `src/intents/evals/scorer.ts` imports from `../../backtest/occ-symbology`
- `src/backtest/market-data.ts`, `sim-broker.ts`, `databento-tape.ts`, `test-fixtures.ts`

Update all import paths (~7 consumers). The IBKR client's `symbology.ts` will import
`parseOccSymbol` from `src/lib/occ-symbology` to decompose OCC symbols into conId
resolve params.

**0.2 — `extractUnderlying`: deduplicate into `src/lib/occ-symbology.ts`**

Two independent implementations exist:
- `src/reconciliation/reconciler.ts:184` — splits on whitespace, fragile
- `src/intents/orchestrator/position-path.ts:29` — regex capture group, cleaner

Export one canonical `extractUnderlying` from the new `src/lib/occ-symbology.ts`
(use the regex version). Delete both local copies. The IBKR client will also need
this for mapping broker positions back to underlyings.

**0.3 — `classifyError`: export from `src/lib/resilient.ts`**

`src/broker/tradestation/client.ts:33` has `classifyGeneric` — a verbatim copy of
`classifyError` in `src/lib/resilient.ts` (the comment admits "mirrors resilient.ts").
Also redeclares a local `ErrorCategory` type.

Export `classifyError` and `ErrorCategory` from `src/lib/resilient.ts`. Delete
`classifyGeneric` + local type from `client.ts`. The IBKR client's error classifier
(`ibkrClassify`) will compose with the shared `classifyError` as its fallback, same
pattern TradeStation uses with `tsClassify`.

**0.4 — `getSpreadWidth`: move to `src/lib/trade.ts`**

Currently in `src/backtest/margin-model.ts:47`. Computes `Math.abs(strikes[0] - strikes[1])`
from a `TradeLeg[]` — a spread-structure property, not a margin concept. Takes `TradeLeg[]`
from `src/db/schema.ts` with no margin dependencies. `src/lib/trade.ts` already has
`contractMultiplier`, `notionalValue`, etc. — spread width fits there.

**0.5 — `normalizeExpiry` vs `resolveExpiryHint`: audit and consolidate (deferred)**

Two parallel implementations normalize human-readable expiry strings to YYYY-MM-DD:
- `normalizeExpiry` in `src/backtest/occ-symbology.ts` (366 lines)
- `resolveExpiryHint` in `src/intents/orchestrator/expiry-resolver.ts` (ET-aware)

These overlap significantly (0DTE, tomorrow, next friday, month names). Full
consolidation is a bigger refactor — defer to after IBKR migration is stable.
For now, moving `normalizeExpiry` with the rest of `occ-symbology.ts` to `src/lib/`
is sufficient. Flag the duplication with a `// TODO: consolidate with expiry-resolver.ts`
comment.

---

### Phase 1: Java Sidecar (can develop independently, parallel with Phase 0)

1. Set up Gradle project in `sidecar/` with Javalin + TwsApi.jar
2. Implement `TwsBridge.java` — EWrapper, EReader thread, connection lifecycle
3. Implement contract resolution endpoint (`/api/contracts/resolve`)
4. Implement market data snapshot endpoint (`/api/market-data/snapshot`)
5. Implement single order endpoints (`/api/orders/single`, `GET/PUT/DELETE`)
6. Implement combo order endpoint (`/api/orders/combo`) with BAG construction
7. Implement positions + account summary endpoints
8. Implement WebSocket event broadcasting
9. Implement reconnection logic with maintenance window awareness
10. **Test against IB Gateway paper trading (port 4002)**

### Phase 2: TypeScript IBKR Client (depends on Phase 0 + Phase 1)

1. Create `src/broker/ibkr/schemas.ts` — Zod schemas for all sidecar responses
2. Create `src/broker/ibkr/symbology.ts` — imports `parseOccSymbol`, `isOccOptionSymbol`
   from `src/lib/occ-symbology` + conId resolution/caching via sidecar
3. Create `src/broker/ibkr/client.ts` — BrokerService implementation; error classifier
   composes with shared `classifyError` from `src/lib/resilient`
4. Create `src/broker/ibkr/ws-listener.ts` — WebSocket event consumer
5. Create `src/broker/ibkr/index.ts` — exports `ibkrService`
6. Add `BROKER` env var to broker factory for runtime selection
7. **Test all BrokerService methods against sidecar + paper trading**

### Phase 3: Integration Testing

1. Wire IBKR client into live runner (behind `BROKER=ibkr` flag)
2. Test full pipeline: OneOption signal → parser → orchestrator → execute → IBKR order
3. Test OrderManager price-chase with IBKR (modify order flow)
4. Test reconciliation against IBKR positions
5. Test fill sweep with IBKR order status polling
6. Test all alert paths (disconnect, reconnect, margin exceeded, order rejected)
7. Verify spread midpoint pricing works with IBKR quotes
8. **Run on paper trading for 1+ week before going live**

### Phase 4: Production Cutover

1. Set up IB Gateway with live credentials (port 4001)
2. Install all three launchd plists (Gateway, sidecar, Trade Follower)
3. Set `BROKER=ibkr` in production .env
4. Set up Sunday 2FA reminder cron → `sendPushover('IBKR 2FA Required', '...')`
5. Monitor for 1 week with both TradeStation and IBKR running (IBKR active, TS read-only for position comparison)
6. Remove TradeStation credentials after confidence period

---

## 9. Things That Would Go Wrong Without This Adaptation

1. **Original plan says Telegram** — We use Discord webhooks + Pushover. All alerts go through `src/lib/alert.ts:sendSystemAlert()`. Pushover is for critical/emergency only.

2. **Original plan creates a separate `bot/` directory** — Wrong. The IBKR client lives at `src/broker/ibkr/` and implements the existing `BrokerService` interface. No new entry point.

3. **Original plan re-implements position tracking** — Wrong. Positions are tracked in the DB via `trades` table. The broker's `getPositions()` is only for reconciliation.

4. **Original plan re-implements order management** — Wrong. The existing `OrderManager` handles price-chase, auto-cancel, and fill polling. It works with any `BrokerService`.

5. **Original plan puts business logic in the sidecar** — Wrong. The sidecar is a pure protocol translator. All business logic (risk checks, sizing, spread selection, scheduling) stays in the existing TypeScript pipeline.

6. **Original plan suggests spread reconstruction at the broker level** — Not needed. The reconciler compares individual positions, and the DB tracks spreads natively.

7. **Original plan uses port 8080** — Changed to 8090 to avoid conflicts with any existing services. The existing local API (`src/local-api/server.ts`) uses port 4000, web uses 3000.

8. **Original plan creates bracket orders (parent + TP + SL)** — The existing Trade Follower pipeline doesn't use bracket orders. Orders are placed as individual LIMIT orders with price-chase via OrderManager. Closing orders are separate signals from the traders. Bracket order support is NOT needed for initial migration.

9. **Original plan doesn't account for the signal flow** — Trade signals come from OneOption chat (Playwright + SignalR), get parsed by the orchestrator, and reach the broker via `execute-resolved.ts`. The sidecar never sees signals — it only sees individual order placement requests.

10. **Original plan uses `Decimal` type note** — This is a Java sidecar concern, not TypeScript. The sidecar's `TwsBridge.java` must use `Decimal.get(n)` for quantity fields in IBKR API 10.40+.

---

## 10. Reference Links

- TWS API download: https://interactivebrokers.github.io
- TWS API Java docs: https://ibkrcampus.com/ibkr-api-page/twsapi-doc/
- Combo contracts: https://ibkrcampus.com/ibkr-api-page/contracts/
- Error codes: https://interactivebrokers.github.io/tws-api/message_codes.html
- IBC repo: https://github.com/IbcAlpha/IBC
- ibkrfacade reference: https://github.com/medovarszki/ibkrfacade
- IB Gateway download: https://www.interactivebrokers.com/en/trading/ibgateway-latest.php
