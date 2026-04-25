# Memory Leak Audit (Pre-Live)

## Problem

Long-lived process going live — leaks compound. Audited for unbounded in-memory structures, dangling connections, missing cleanup on hot paths.

## Decision

Fixed the real leaks, added process metrics. Skipped noise (SignalR listeners are page-scoped and die with the page; tick-cache pool is backtest-only).

## Key Files

- `src/broker/ibkr/client.ts` — two fixes
- `src/lib/process-metrics.ts` — new: periodic heap/RSS/fd log + drift alert
- `src/index.ts` — wired metrics start/stop, pgPool.end() on shutdown
- `src/lib/healthcheck.ts` — added AbortSignal.timeout to ping fetch

## Fixes Made

### `creditComboOrderIds` Set (HIGH)
Module-level Set tracking credit combo order IDs for sign convention in `modifyOrder`. Entries were added in `placeOrder` and only removed in `cancelOrder`. Filled orders were never removed — the Set grew forever.
Fix: `creditComboOrderIds.delete(orderId)` added in `getOrderStatus()` when `status === 'FILLED'`.

### `alertedMissingSubscription` Set (HIGH → functional + minor growth)
Module-level Set preventing duplicate 402 alerts per symbol. Problem: symbols are never evicted, so (a) a resolved subscription issue would never re-alert, and (b) the set grows unboundedly (low practical impact but still wrong).
Fix: Changed to `Map<string, number>` (symbol → epoch ms) with 24h TTL. On-access eviction keeps the map bounded. Now re-alerts after 24h if the issue persists.

### Process metrics (new)
`src/lib/process-metrics.ts` logs `heap=NMB rss=NMB fds=N` every 5 minutes. Tracks a 12-sample (1-hour) window and fires a Discord warning alert if heap grows >50MB/hr. Window resets after alert to avoid alert storms.

### Healthcheck ping timeout
`healthcheck.ts` was calling `fetch(pingUrl)` with no timeout. A slow healthchecks.io response would hang indefinitely. Added `AbortSignal.timeout(10_000)`.

### pgPool.end() on shutdown
Added to the shutdown sequence in `index.ts` after all DB operations complete (before `process.exit`). Prevents Postgres from logging unexpected disconnects.

## Watch Out

- `tick-cache-client.ts` has its own pg.Pool with no shutdown hook — but it's only imported by backtest code, never by the live process (`src/index.ts`). Not a concern for live.
- The `heapSamples` array in process-metrics is reset after a drift alert fires. This means if the leak is real and continuous, you get one alert per hour rather than one alert total.
- `creditComboOrderIds` still has no explicit shutdown drain — but since the set is bounded by working order count (small, single-digit in practice), this is fine.
