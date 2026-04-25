# vibrant-margulis-34746b — Position Aging & Stale-Exit Detection

## Goal

Catch two pre-live failure modes: (1) positions held past the trader's typical hold time without a CLOSE signal; (2) trader sends a CLOSE that the bot skipped as `no_open_position` while a position remains open (silent miss). Surface as Discord/Pushover alerts and a dashboard panel; force-close is opt-in via env var.

## Changes

- `src/lib/position-aging.ts` (new) — pure compute: `computeTraderAvgHoldMs()`, `detectStalePositions()`, `detectMissedCloses()`. No I/O.
- `src/lib/position-aging.test.ts` (new) — 15 vitest cases covering the three pure functions.
- `src/live/stale-position-sweeper.ts` (new) — DB reads, detection wiring, alerts via `sendSystemAlert`/`sendPushover`, optional force-close via `broker.placeOrder` + `recordTrade`.
- `src/local-api/server.ts` — wires sweeper to `setInterval` (hourly, +5min startup delay) iterating `channelBrokerMap`. Reads `STALE_POSITION_THRESHOLD_DAYS` and `STALE_POSITION_FORCE_CLOSE_DAYS` from env.
- `src/local-api/routes/web-queries.ts` — `GET /web/stale-positions` returns `{ stalePositions, missedCloses }` for the dashboard.
- `web/src/lib/queries.ts` — adds `queries.dashboard.stalePositions()`, declares `StalePositionRow` / `MissedCloseRow` / `StalePositionsResponse`.
- `web/src/views/dashboard/page.tsx` — adds second `useQuery`, threads `staleData` through `DashboardContent`, conditionally renders panel.
- `web/src/views/dashboard/stale-positions-panel.tsx` (new) — alert panel with two sections (stale positions, missed closes); links to trade detail.
- `docs/lessons/2026-04-24-position-aging-stale-exit.md` — author's rationale.

## Justification per change

- **Pure compute split.** `position-aging.ts` is correctly factored — pure, no I/O, fully unit-tested. The threshold formula `max(traderAvg, defaultThreshold)` is sensible: floor protects against day traders setting absurdly short alarms.
- **Alert sweep.** Stale-position alerting is genuinely needed pre-live and there is no equivalent today (`reconciliation/scheduler.ts` covers fill drift, not aging). Hourly cadence is reasonable.
- **Dashboard panel.** Renders nothing when clean (`if (total === 0) return null`); zero footprint when there are no alerts. Uses theme tokens (`text-warning`, `border-destructive/20`) — no hard-coded colors.
- **Missed-close detector.** Cross-references `runDecisions` skips against currently-open `(trader, symbol)` pairs. This is the closest the codebase has to a "we missed an exit signal" check, which is exactly the failure mode that bites a copy bot.

## Concerns

### BLOCKER: force-close call to `recordTrade` is broken

In `src/live/stale-position-sweeper.ts:105-113`, the call passes neither `action` nor `legs`:

```ts
await recordTrade({
  tradeId: trade.id,
  symbol: trade.symbol,
  trader: trade.trader,
  exitPrice: orderResult.filledPrice ?? 0,
  closedAt: ...,
  channelId,
  metadata: { forceExit: true, ... },
});
```

In `record-trade.ts`, with `tradeId` set the function takes the existing-position branch. `incomingLegs` defaults to `[]`. `deriveActionFromLegs([], existingLegs, qty)` returns `null` on line 183 (`incomingLegs.length === 0`). `effectiveAction = derived ?? action` is `undefined`. The function logs `"Cannot determine action..."` at debug level and returns `null` (line 357-360). The DB trade row stays `OPEN`.

Net effect: the broker gets a real market order to flatten the position, but the trade row is never marked CLOSED, no `trade_events` row is appended, no exit price/PnL is recorded, and no lifecycle alert fires. Reconciliation may or may not catch it. This is the worst possible outcome of an "auto-close" feature: side effect happened, audit log is silent, dashboard still shows the position open.

Fix: pass `action: 'CLOSE'` and the closing legs to `recordTrade` (and let `closeFlags` set `'autoClose'` because `closeMessageId` is undefined).

### BLOCKER: auto-close action policy needs explicit gating

Force-close auto-pulls the trigger via market order based on a wall-clock age threshold. Today the gate is "broker is present + env var > 0." That's not enough for live trading:

- No confirmation that the position is still actually open at the broker (no `getPositions()` reconciliation before placing the closing market order).
- No quote check / liquidity check.
- After-hours / weekend behavior is unspecified — sweep runs hourly regardless.
- Failure mode = missed CLOSE message in the room (the very case this feature is meant to *detect*) directly triggers an automated counter-trade. Race condition: if the room operator sends the CLOSE manually 30 seconds later, the bot has already double-flattened.

Per the rubric: "Auto-closing without confirmation is the wrong kind of real." Leaving force-close behind an env var that defaults to 0 mitigates somewhat, but the code itself has none of the safeguards (broker position check, market hours, alert-and-wait window) that make auto-close defensible. **Recommend force-close be removed from this PR** — keep the alert path, ship auto-close in a separate worktree with the safeguards.

### MAJOR: missed-close detector has a temporal hole

`detectMissedCloses()` matches any skip in the last 500 against any currently-open `(author, symbol)` pair. There is no check that the skip happened *after* the open position's `openedAt`. A `no_open_position` skip from an earlier episode (where the trader closed and reopened) will falsely flag the new position. The 500-row limit bounds the blast radius but does not eliminate it.

Fix: in `detectMissedCloses`, take the open trade's `openedAt` and ignore skips with `createdAt < openedAt`. Currently `skipDecisions` carries `createdAt` but the function never consumes it.

### MAJOR: lessons.md "shape-plumbing cruft" — duplicate types

`web/src/lib/queries.ts` declares `StalePositionRow` and `MissedCloseRow` as inline shapes structurally identical to `StalePosition` and `MissedClose` exported from `src/lib/position-aging.ts`. Both reference the same `Trade` type via `@src/db/schema`. Per `.claude/rules/lessons.md`: "Import, don't redeclare. Views/components import the canonical type; never re-spell."

There is also an identity `.map()` in `web-queries.ts` `/stale-positions` handler (the `stalePositions.map(...)` block) that destructures `thresholdDays: thresh` only to re-emit it as `thresholdDays: thresh`. After your changes this is the kind of identity rename lessons.md tells you to delete.

Fix: import `StalePosition` and `MissedClose` from `@src/lib/position-aging` and drop `StalePositionRow` / `MissedCloseRow`. Drop the identity `.map()` and return `stalePositions` directly.

### MINOR: silent staleQuery error in dashboard

`staleQuery.data ?? null` swallows errors. If the API returns 500, the dashboard renders fine but the user has no signal that the alert pipeline is broken. Consider toasting `staleQuery.error` once or wiring an inline error indicator. For an alerting feature, silent failure is theatre.

### MINOR: panel renders raw `<Link>` rows, not via shared list primitives

Fine for a small alert list (≤ ~5 rows in practice). Not blocking.

### MINOR: parallel DB reads duplicated between sweeper and route

`sweepStalePositions()` and the `/web/stale-positions` route execute the same three `Promise.all` queries with the same logic. Both are short-lived and run on different cadences (hourly sweeper, 5-min UI poll), so the duplication is small, but if the schema for `runDecisions` or the limits drift, both sites need editing. A shared `loadAgingInputs(channelId)` would be cleaner.

### MINOR: bypasses `RuntimeChannelService`

Sweeper iterates `channelBrokerMap` directly from `getRuntimeBrokerMap()` rather than going through the `RuntimeChannelService` abstraction described in `.claude/rules/broker-interface.md`. Not a strict violation — the existing `sweepStaleRuns` neighbor uses the same pattern.

## Verdict: REWORK

The diagnosis is real and the alert layer is well-factored — pure compute split, good unit tests, sensible threshold formula, panel that hides itself when clean. This is the kind of pre-live safety net the project actually needs.

Two BLOCKERS prevent merge as-is:

1. **The force-close path silently desyncs broker state and DB state** because `recordTrade` is called without `action`/`legs` and falls through to the no-op return. The broker order goes through, but the trade row stays OPEN. For an auto-close feature, this is the worst possible outcome.
2. **Auto-close policy is too thin for live**: no broker-position reconciliation, no market-hours guard, no alert-and-wait window. The very condition this feature exists to detect (a missed CLOSE) is the trigger that fires the automated counter-trade.

Plus one MAJOR (temporal hole — false positives across reopen cycles) and a lessons.md duplicate-types violation.

If the author drops force-close entirely from this PR (defaulting `STALE_POSITION_FORCE_CLOSE_DAYS` to 0 is not enough — the broken code stays in main), fixes the temporal hole, and removes the duplicate web types, this is a clean MERGE. The pure-alert path is exactly what's needed.

## Required fixes

1. **Remove the force-close block from `stale-position-sweeper.ts`** (lines 81-132) and the `STALE_POSITION_FORCE_CLOSE_DAYS` env var from `server.ts`. Land it in a separate worktree with: `broker.getPositions()` confirmation before the order, market-hours guard, `sendSystemAlert` + N-minute confirmation window, and a fixed `recordTrade` call. Alternatively, if force-close stays, **fix the `recordTrade` call** to pass `action: 'CLOSE'` and the closing legs.
2. **Fix `detectMissedCloses` temporal correctness**: pass each open trade's `openedAt` and skip decisions with `createdAt < openedAt`. Update one test fixture.
3. **Drop duplicate types in `web/src/lib/queries.ts`**: import `StalePosition` and `MissedClose` from `@src/lib/position-aging`. Drop `StalePositionRow` / `MissedCloseRow`. Update `stale-positions-panel.tsx` imports.
4. **Remove identity `.map()` in `web-queries.ts`** `/stale-positions` handler — return `stalePositions` directly.
5. **Surface `staleQuery.error`** in the dashboard at minimum via `console.error` or a one-shot toast — silent failure is theatre when this is the alerting pipeline.

## Reviewer verdict

**REWORK** — concur with the thesis on every load-bearing point. Tried to falsify each blocker and failed.

### Agreements
- **BLOCKER #1 (force-close desync) is real.** Walked the call chain in `record-trade.ts:340-360`. With `tradeId` set the function takes the existing-position branch; `incomingLegs = legs ?? []` is `[]`; `deriveActionFromLegs` returns `null` on line 183 (`incomingLegs.length === 0`); `effectiveAction = derived ?? action` is `undefined` because the sweeper passes no `action`; line 357-359 logs at `debug` and returns `null`. The market order at the broker fires (line 97 of the sweeper, before `recordTrade`), so the position is flattened in IBKR while the `trades` row stays OPEN, no `trade_events` row is appended, no PnL recorded, and the dashboard keeps surfacing the position as stale on the next sweep — which would re-fire the order if `forceCloseDays` stays met. This is a duplicate-flatten foot-gun, not just a silent audit gap.
- **BLOCKER #2 (auto-close policy too thin) is real.** No `broker.getPositions()` confirm, no market-hours guard, no alert-and-wait. Worse: the `setTimeout(runStalePositionSweep, 5*60*1000)` at server.ts:216 runs the sweep 5 min after process start regardless of clock — restart on a Saturday at 9pm and you fire market orders into a closed market. Defaulting `STALE_POSITION_FORCE_CLOSE_DAYS=0` is mitigation, not safety; the broken codepath stays in main.
- **MAJOR (temporal hole) is real.** `detectMissedCloses` (position-aging.ts:85-131) accepts `createdAt` on each skip but never reads it. Reopen-then-skip-from-prior-cycle false-positives are possible.
- **MAJOR (lessons.md duplicate types) is real.** `web/src/lib/queries.ts:17-36` re-spells `StalePosition`/`MissedClose` exported from `src/lib/position-aging.ts:30-35,68-75` — structurally identical, same `Trade`. The route handler at `web-queries.ts:3027-3032` is a textbook identity `.map()` (destructure only renames `thresholdDays → thresh` to immediately re-emit `thresholdDays: thresh`). Both are exactly what `lessons.md` says to delete. The panel's `import type { StalePositionRow, MissedCloseRow } from '@/lib/queries'` would be a one-line swap to `@src/lib/position-aging`.

### Disagreements
- None material. MINOR on `staleQuery.error` is fair but lower severity than thesis frames; for a single-user app one `console.error` suffices.

### Missed
- `setTimeout(runStalePositionSweep, 5*60*1000)` runs unconditionally on every `local-api` restart. Combined with force-close, restart-loop = order-loop. Add this to BLOCKER #2.
- Force-close marks the alert as `severity: 'critical'` *after* placing the order, but if `recordTrade` returns `null` (the BLOCKER #1 path), the success alert still fires saying "Position auto-closed" — the alert lies.
- Sweeper uses `db` directly while the rest of `local-api` already passes `channelBrokerMap` through `createTradesRouter`/`createWebOrdersRouter`. Inconsistent but not blocking.

### Verdict
REWORK. Drop force-close from this PR (delete sweeper lines 81-132 + server.ts staleForceCloseDays). Fix the temporal hole. Collapse the duplicate web types and identity `.map()`. The pure-alert path is solid and ship-worthy on its own.

Path: `/Users/jason/Workspace/trade-follower-3/.claude/worktree-review/vibrant-margulis-34746b.md`
