# Worktree review: relaxed-bell-7b40c5 — memory-leak audit

## Goal

Pre-live audit of the long-lived process for unbounded in-memory structures, dangling connections, and missing cleanup on hot paths. Adds periodic process metrics (heap/RSS/fd) with a drift alert.

## Changes

1. `src/broker/ibkr/client.ts`
   - `creditComboOrderIds` Set: add `.delete(orderId)` inside `getOrderStatus()` when `status === 'FILLED'`. Previously only `cancelOrder()` removed entries — filled orders grew the Set forever.
   - `alertedMissingSubscription` renamed to `alertedSubscriptionAt` and changed from `Set<string>` to `Map<string, number>` (symbol -> epoch ms) with a 24h TTL. On-access eviction prunes stale entries; 402 alerts re-fire per symbol after 24h instead of being permanently suppressed.
2. `src/lib/process-metrics.ts` (new, 59 lines)
   - `setInterval` every 5 min -> logs `heap=NMB rss=NMB fds=N` via `console.log`.
   - Maintains a rolling 12-sample heap window; if heap grew >50MB/hr, emits `sendSystemAlert` (severity=warning, goes to Discord + console) and resets the window to avoid alert storms.
   - `getFdCount()` reads `/proc/self/fd` (Linux-only; returns null elsewhere).
3. `src/index.ts`
   - Imports `pgPool` from `./db/client.js`; adds `startMetrics()/stopMetrics()` alongside healthcheck; calls `await pgPool.end()` in the shutdown sequence after browser close, before `releaseLock`.
4. `src/lib/healthcheck.ts`
   - Adds `AbortSignal.timeout(10_000)` to the `fetch(pingUrl)` call so a hung healthchecks.io response can't stall the ping loop.
5. `docs/lessons/2026-04-24-memory-leak-audit.md` — rationale, what was skipped, and known remaining caveats.

## Justification per change

- **`creditComboOrderIds` FILLED-path delete.** Real bug. The Set is mutated in `placeOrder` (add), `modifyOrder` (read), `cancelOrder` (delete) — but `getOrderStatus` is the only place we learn about a fill. Without eviction on fill, every credit-combo order that fills (the common terminal state) permanently leaks an entry. Fix is minimal and correct.
- **`alertedSubscriptionAt` TTL map.** Legitimate. Previous behavior permanently suppressed 402 alerts per symbol, so a recurring subscription regression after the first alert would go silent. TTL map with on-access eviction is the right tradeoff — bounded by (symbols-seen-with-402 x 24h) which is tiny. The inline for-loop eviction is O(n) per alert which is fine at this scale.
- **Process metrics.** Legitimate for going live. Uses `process.memoryUsage()` directly (no reinvention). Drift alert ties into the existing `sendSystemAlert` path -> Discord webhook. Numbers are conservative (50MB/hr over a 1-hour window) which should avoid noise from GC jitter. `console.log` lines are readable in stdout and already the idiom here (healthcheck + alert both use `console`).
- **Healthcheck ping timeout.** Trivially correct. 10s is generous for a healthchecks.io ping; pairs the existing 5s timeout on the sidecar `/status` probe.
- **`pgPool.end()` on shutdown.** Correct ordering — placed after `awaitDrain()`, `destroyOrderManager()`, reconcilers/sweeps, browser close, so no pool consumer remains. Prevents Postgres "unexpected disconnect" log noise and lets the pool flush.

## Concerns

1. **Drift-alert window reset after firing.** Comment notes this is to avoid alert storms, but the side effect is the leak must keep growing >50MB/hr in a fresh 1-hour window to re-alert. For a slow leak this means one alert followed by silence until the process OOMs. Single-user-appropriate (one alert is enough to prompt a restart) but worth naming. Not a blocker.
2. **`/proc/self/fd` is Linux-only.** On macOS (this is a darwin machine per env) `getFdCount` silently returns `null` and the log line just omits fds. Fine for prod Linux, but in local dev you get a partial line. Cosmetic.
3. **Process-metrics has no test.** The module is self-contained and low-complexity so this is probably fine; the drift math is simple enough to verify by reading. No blocker.
4. **No shutdown drain for `creditComboOrderIds` itself.** Author acknowledges — correctly dismisses as a non-issue because the working-order count is tiny and the Set dies with the process. Agree.
5. **Eviction loop in the 402 alert handler iterates the whole map on every alert.** At the projected scale (handful of symbols ever seeing a 402) this is fine. Would not scale to tens of thousands of symbols, but we don't have that.
6. **Not upstreamed.** The `Agent.run()` timeout race the audit checklist flagged is not in scope here — this worktree only touches broker/process/infra. Not a concern for this audit.

## Verdict: MERGE

Tight, targeted, and honest. Two real leaks fixed (the credit-combo Set is an actual growing-over-time bug; the 402 alert Set is bounded-but-broken semantics), one missing timeout closed, one missing shutdown hook added, and a genuinely useful metric loop wired into the existing alert path. No `if (isBacktest)` leakage, no pipeline rule violations, no reinvention of `process.memoryUsage`, no unused emitters — the drift alert has a consumer (`sendSystemAlert` -> Discord + console). The lesson file is explicit about what was deliberately skipped (SignalR listeners, tick-cache pool) and the remaining caveats, which is exactly the discipline the one-rule wants. Backend `tsc --noEmit` passes cleanly. Single-user scope is respected; no multi-tenant concepts introduced. Merge.

## Required fixes

None blocking. Optional, if the author wants a second pass:

- Consider softening the drift window reset: drop the oldest half of `heapSamples` instead of wiping it, so a continuing leak re-alerts in ~30 min rather than waiting a full fresh hour.
- Consider adding `rssMB` to the drift check too (heap can stay flat while RSS balloons from native allocations, e.g. Playwright).
- If `/proc/self/fd` matters on darwin dev loops, `lsof -p <pid>` works but is heavy; probably not worth it.

## Reviewer verdict

Attempted to falsify; could not. Every load-bearing claim checks out:

- `process-metrics.ts` uses `process.memoryUsage()` directly, no reinvention. 59 lines. No RSS-cap kill path, no `process.exit` — drift only calls `sendSystemAlert` with `severity: 'warning'`, a real consumer (`src/lib/alert.ts:57` — logs + Discord webhook). Metrics are not emitted into the void.
- `creditComboOrderIds` call sites in `src/broker/ibkr/client.ts`: `add` at 327 (placeOrder), `has` at 351 (modifyOrder re-sign), `delete` at 385 (cancelOrder) and now 415 (getOrderStatus FILLED). FILLED is the common terminal — the leak was real.
- `alertedSubscriptionAt` TTL-evicts on access (lines 231–232), correctly bounded. Semantics change from permanent-suppress to 24h-suppress is an improvement, not a regression.
- `pgPool` export at `src/db/client.ts:13` is real; `pgPool.end()` ordering in `shutdown()` is after `awaitDrain()`, `destroyOrderManager()`, recon schedulers, fill sweeps, and `closeBrowser()` — nothing left to hit the pool. Correct placement.
- `AbortSignal.timeout(10_000)` on the healthchecks.io fetch — trivially right.
- `npx tsc --noEmit` on the worktree passes cleanly (silent exit).
- `startMetrics`/`stopMetrics` paired in `main()` and `shutdown()`; `stopMetrics` clears interval and zeros the sample buffer so a restart in-process starts fresh.

Tried a few failure modes:
- Could the drift alert fire spuriously during warmup and block the pipeline? No — it's `void sendSystemAlert(...)`, fire-and-forget, and there's no exit on alert.
- Could the eviction loop mutate the map while iterating it? JS `Map` iteration tolerates concurrent deletes of already-visited and current keys; deleting future keys skips them. No hazard here since we only delete stale entries and the iteration is synchronous.
- Could `await pgPool.end()` hang shutdown? No timeout wrapper — but all consumers have drained by then, and `pool.end()` on an idle pool returns immediately. Acceptable.
- Any `if (isBacktest)` smell? None; changes are confined to live-path infra.

Thesis's self-identified concerns (window-reset-after-alert, /proc-on-darwin, no test for the metrics module) are all fair and non-blocking. No additional concerns found. Agree: **MERGE**.

Path: `/Users/jason/Workspace/trade-follower-3/.claude/worktree-review/relaxed-bell-7b40c5.md`
