# objective-roentgen-c58003

## Goal
Pre-live audit of chat ingestion to close four "silent signal-drop" paths between Playwright → SignalR → DB → task queue. Lesson: queue overflow detection, gap-fill task replay, page-crash detection, missing-Id surfacing.

## Changes (5 files, ~65 LOC net)
1. `src/ingestion/browser.ts` — `crashed` promise also resolves on `page.on('close')`, not just `browser.on('disconnected')`.
2. `src/ingestion/historical.ts` — `fetchHistorical` accepts optional `onNewMessage`. `fetchDay` returns `newMessages: SignalRMessage[]` and switches insert from `onConflictDoUpdate` to `onConflictDoNothing` + a separate `UPDATE ... SET reactions` for existing rows.
3. `src/ingestion/ingest.ts` — `gapFill(daysBack, onNewMessage?)`. `superviseIngestion` only forwards `onMessage` on reconnect (`isFirstBoot=false`); first-boot 30-day backfill gets `undefined` so historical trades aren't re-executed.
4. `src/ingestion/signalr.ts` — warns when `Id` is missing before falling back to `crypto.randomUUID()`.
5. `src/live/runner.ts` — `QUEUE_DEPTH_WARN_THRESHOLD = 5`; `submitTask` fires `sendSystemAlert` when crossed.

## Justification per change
- **Page-close handler:** Real bug. Renderer can die (OOM, about:crash, navigation off origin) while browser process stays alive; without it, `await crashed` parks until the 10-min watchdog. Necessary for live.
- **Gap-fill replay:** Real bug. Reconnect window messages persisted but never created tasks. The `isFirstBoot ? undefined : onMessage` gate is correct — replaying 30 days of OPENs would be catastrophic. The on-conflict split also fixes `savedCount` semantics (previously every processed row counted as "saved").
- **Queue depth alert:** Necessary. Current model only alerts post-hoc at 60s STALE_THRESHOLD expiry — by then the signal is lost. Threshold of 5 fits a single-user system where typical depth is 0-1.
- **Id-missing warning:** Cheap and proportionate. Surfaces silent dedup-bypass for diagnosis.

## Concerns
1. **Alert spam — no cooldown on queue-depth alert.** `submitTask` alerts on *every* call once depth >= 5. Sustained 7-deep queue produces an alert per push. Author flags this in the lesson's "Watch Out". Pushover priority=2 + Discord on every push = alert fatigue day one. Needs a per-channel `lastQueueDepthAlertAt` with ~5min cooldown.
2. **Polling fallback has the same bug the audit fixes.** `pollForMessages()` (used when browser can't reach `/chat`) calls `fetchHistorical({ since: today, until: today })` *without* `onNewMessage`. Identical signal-drop pathology to the reconnect gap-fill the author just fixed, two functions away. Not addressed.
3. **`onNewMessage` ordering.** Callbacks await serially after each day's writes complete. For 1000+ message reconnect days, task creation lags. Runner staleness guard uses `task.createdAt` (insert-time), so probably safe — but fragile.
4. **No test coverage.** Five files, zero unit tests. The `onConflictDoNothing` + manual-update split in `fetchDay` is the kind of thing easy to silently regress.
5. **Type drift.** `gapFill` callback is `void | Promise<void>` but `fetchHistorical` requires `Promise<void>`. The wrap-shim bridges, but invites future "why isn't this awaited?" debugging.

## Verdict
**REWORK** — Four diagnosed bugs are real, fixes are minimal and correctly scoped, typecheck passes, rails respected (no `if (isBacktest)` in pipeline/orders, no defensive layers, single-user appropriate). Page-close and gap-fill replay alone justify merge — both are concrete pre-live signal-drop paths. Not bloat; callback-threading is reasonable for two call sites. Alert-spam concern could turn a useful signal into ignored noise day one. Polling-fallback omission is a straight-line miss of the same bug class. Neither blocker alone, but both should land before this does.

## Required fixes
1. **Cooldown on queue-depth alert** in `src/live/runner.ts`: per-channel `lastQueueDepthAlertAt: number` on `ChannelRunnerState`, gate `sendSystemAlert` on `Date.now() - lastQueueDepthAlertAt > 5 * 60_000`.
2. **Pass `onNewMessage` from `pollForMessages()`** in `src/ingestion/ingest.ts`, or delete the polling fallback. Currently it silently re-introduces the exact bug the audit closes.

## Nice-to-have (not blocking)
- Shared `OnMessage` type alias used in both `fetchHistorical` and `gapFill`, killing the wrap-shim.
- Unit test: call `fetchDay` twice on same Id, assert `newMessages` is `[msg]` then `[]`.
- Reconsider whether the polling fallback is still needed at all given the audit's watchdog + page-close + reconnect coverage.

## Reviewer verdict

Verified against diff at `objective-roentgen-c58003` (5 files modified + 1 lesson; tree clean otherwise).

**Concern 1 (alert spam) — CONFIRMED.** `src/live/runner.ts:82-88` invokes `sendSystemAlert` unconditionally inside `submitTask` whenever `state.queue.length >= 5`. No debounce, no `lastAlertAt`, no transition-edge check. A sustained 7-deep queue under rapid SignalR pushes yields one Discord alert per enqueue. Severity is `warning`, so `src/lib/alert.ts:93` skips Pushover — but Discord flood is still alert fatigue. Thesis's proposed fix (per-channel `lastQueueDepthAlertAt` on `ChannelRunnerState` with 5min gate) is the right shape; trigger should be a low→high edge, not `>=` every push.

**Concern 2 (polling fallback signal drop) — CONFIRMED.** `src/ingestion/ingest.ts:345` calls `await fetchHistorical({ since: today, until: today })` with no `onNewMessage`. This is the exact bug the audit fixed for reconnect gap-fill two screens up (`ingest.ts:91-96`). Because `fetchDay` now uses `onConflictDoNothing` + returns `newMessages`, the 15s polling loop genuinely picks up new messages into the DB but never fans them into `submitTask`. Worse than reconnect gap-fill: this runs continuously while the fallback is active, so every signal posted during a polling session is silently orphaned. Author fixed the single-boot case but left the steady-state case broken. Straight-line miss.

**Concern 4 (no tests) — CONFIRMED.** `find src/ingestion -name '*.test.ts'` returns nothing. `src/live/factory.test.ts` exists but doesn't exercise queue-depth alerting or the new `fetchDay` return shape. The `onConflictDoNothing` + separate `UPDATE reactions` split in `historical.ts:262-271` is precisely the regression-prone pattern a 10-line unit test would lock down (insert twice with changed reactions, assert `newMessages.length === 1` on second call, assert reactions updated).

**Additional finding.** `ingest.ts:287` awaits `crashed` then calls `stopPollingFallback()`. With the new `page.on('close')` resolver in `browser.ts:63-66`, `crashed` now resolves on renderer crash even if `browser.isConnected()` is still true. The subsequent outer loop iteration calls `launchBrowser()` fresh, which is fine, but the old `browser` handle is never explicitly closed in `ingest.ts` — relies on GC / process exit. Minor, not a blocker.

**Verdict: REWORK.** Thesis is accurate. Both blockers (1, 2) are real pre-live signal-drop paths — concern 2 in particular is a direct regression of the audit's stated goal. Diagnoses and fixes otherwise sound; typecheck clean; rails respected. Land the two fixes + one unit test for `fetchDay` idempotency, then ship.

Path: `/Users/jason/Workspace/trade-follower-3/.claude/worktree-review/objective-roentgen-c58003.md`
