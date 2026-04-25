# Audit: inspiring-poitras-be27c7 - clock-skew detection

## Goal
Detect system clock skew at backend startup so stale timestamps do not cause order rejections, broken reconciliation, or out-of-order fill timelines once live trading is enabled. Adds 2027 market-calendar entries as a side-quest.

## Changes
1. `src/lib/clock-check.ts` (NEW, 102 lines) - `checkClockSkew(sidecarUrl?)` measures clock skew against (a) `worldtimeapi.org/api/ip` and (b) the IBKR sidecar's `/status` `ibkrServerTimeMs`. Warns at >=500ms, throws (aborts startup) at >=2000ms, also fires `sendSystemAlert`.
2. `src/index.ts` - calls `checkClockSkew()` once before `initRunner()`, then again with the sidecar URL after broker init.
3. `sidecar/.../TwsBridge.java` - adds `lastIbkrServerTimeMs` field, populates it in the `currentTime` callback (`time * 1000L`).
4. `sidecar/.../App.java` - exposes `ibkrServerTimeMs` on the `/status` JSON.
5. `src/broker/ibkr/schemas.ts` - adds `ibkrServerTimeMs: z.number().optional()` to `StatusResponseSchema`. Adds a clarifying comment on `ExecDetailsEventSchema.time` (ET, two-space format).
6. `src/lib/et-date.ts` - appends 2027 market holidays and 2027 early-close days to existing sets.

## Justification per change
- **clock-check.ts + index.ts wiring.** Necessary in spirit. The user is going live; skew on the host clock would corrupt placedAt, fillTime, IBKR ET-format timestamp parsing, reconciliation windows, and the agent's "what hour is it" reasoning. The OS NTP daemon should fix it; TS-level detection + alert is appropriate.
- **Sidecar lastIbkrServerTimeMs exposure.** Tiny, surgical Java change. The currentTime callback already fires every 30s for the heartbeat watchdog; capturing the wire value costs nothing.
- **Schemas.ts comment on ExecDetailsEvent.time.** Pure documentation, lossless, useful - IBKR's YYYYMMDD HH:MM:SS ET format has bitten this codebase before.
- **2027 holiday/early-close additions.** Cheap, correct (verified each date), and unrelated to clock-check. Should arguably be a separate PR but it is hard to object to.

## Concerns

### 1. The IBKR skew check is statistical theatre - guaranteed false positives
measureIbkrSkew() reads ibkrServerTimeMs from /status, which the sidecar only updates when currentTime() fires - every 30 seconds (HEARTBEAT_INTERVAL_MS = 30_000). At any random sample, that value is on average 15s stale, up to 30s. Computing Math.abs(Date.now() - ibkrServerTimeMs) therefore returns a number in [0, 30_000]ms even with a perfectly synced clock.

The author's own inline comment admits this: "inherently coarse. Use it only to detect gross skew (> WARN_THRESHOLD), not sub-second drift." But the thresholds are 500ms and 2000ms - both deterministically tripped by any system that has been running for >2s since the last heartbeat. The very first call to checkClockSkew(sidecarUrl) runs immediately after initRunner(), when the heartbeat may not even have happened yet (ibkrServerTimeMs === 0 is filtered, but the first non-zero reading is still up to 30s late). On a healthy machine, this code will throw and abort startup.

This is the rubric's "false-positive theatre" pattern. The fix is either:
- Have the sidecar issue an on-demand reqCurrentTime() and block the response; sample fresh, then compare.
- Track the local timestamp at which the sidecar received the heartbeat and compute skew accounting for staleness.
- Drop the IBKR check entirely and rely on NTP.

As shipped, the second checkClockSkew(sidecarUrl) call in main() is a startup-failure trap.

### 2. NTP source is worldtimeapi.org - wrong tool
worldtimeapi.org has had documented outages and reliability issues. For a "must pass before going live" check, depending on a free unauthenticated API for the source of truth is fragile. Better options:
- Use the OS clock service directly (already authoritative if NTP is configured) and skip the comparison.
- Use Cloudflare's time.cloudflare.com (NTP/UDP) or its roughtime.cloudflare.com HTTP endpoint.
- Use multiple sources and require consensus.

Round-trip compensation via (before + after) / 2 is fine in shape, but it does not compensate for asymmetric latency. For a 500ms threshold that is marginal.

### 3. Detect-don't-fix is partly correct, but blocking startup IS fixing
The rubric explicitly says clock correction is the OS's job and TS code should DETECT and ALERT. The code alerts, good. But it also throws and prevents the backend from starting at >=2s skew. Given concern #1, this is the worst combination: the failure mode is a startup loop the operator cannot escape without disabling the check or stopping the sidecar. A more conservative design would alert-loud-and-continue, leaving the human to decide whether to halt.

### 4. Lesson file missing
CLAUDE.md says lessons are mandatory after every implementation session; the four 2026-04-24-*.md files in this worktree are unrelated (agent-reference-cleanup, algorithmic-trade-quality, backtest-equity-live-mtm, unrealized-dashboard-messages). There is no 2026-04-24-clock-skew*.md rationale document. The reviewer cannot clock-check the author's reasoning.

### 5. et-date.ts changes are unrelated to the goal
The 2027 calendar entries are correct and harmless, but they should have been a separate PR. They are not "clock skew detection" - they are a market-calendar refresh. Bundling unrelated work obscures intent. (No replication of date math: the additions live alongside the existing sets in the same file. No et-date.ts logic was duplicated in clock-check.ts. Rubric #3 satisfied.)

### 6. No tests
src/lib/clock-check.ts has no .test.ts companion. Pure functions with thresholds and rounding are exactly the kind of code that needs unit tests - mock fetch, assert behaviour at 499/500/1999/2000ms, assert "no source reachable" path does not throw.

### 7. NTP timeout vs IBKR timeout
Minor: Promise.all is fine here (independent), but the 5s NTP timeout is generous compared to the 3s sidecar timeout. A network-degraded NTP path delays startup by up to 5s every restart. Consider a tighter NTP timeout.

### 8. Other rubric checks satisfied
- No if (isBacktest) branches added in pipeline/orders. OK.
- No multi-tenant patterns. OK.
- No replicated et-date.ts logic. OK.
- Upstream-enough: detection sits in src/lib/, called from index.ts. Reasonable.

## Verdict

**REWORK.**

The intent is correct and the project genuinely needs clock-skew detection before going live. But the IBKR-skew code as shipped will reliably false-positive a FATAL at startup because it measures freshness of a 30s-cadence heartbeat snapshot rather than actual skew. That is the textbook detection-theatre the rubric warns against - worse, it is blocking theatre that prevents the backend from booting on a healthy machine. Combined with a fragile NTP source, no tests, no lesson file, and unrelated calendar changes piggybacking, this is not ready to merge. The fix is small but mandatory: either remove the IBKR check or make it sample fresh (on-demand reqCurrentTime + local-receive-timestamp tracking).

## Required fixes (before merge)

1. Fix measureIbkrSkew staleness bug. Either (a) add a sidecar endpoint that triggers reqCurrentTime() and blocks for the response, returning the round-trip; or (b) have the sidecar additionally expose lastIbkrServerTimeReceivedAtMs (local epoch when the callback fired) and compute skew accounting for staleness; or (c) delete the IBKR check entirely and rely on NTP.
2. Replace worldtimeapi.org with a more robust source (Cloudflare, multiple sources, or skip the network check and rely on a local NTP-status check via sntp / chronyc / timedatectl-equivalent).
3. Do not throw at FATAL - alert and let the operator decide. Or, if blocking is desired, gate it behind a CLOCK_CHECK_STRICT=1 env so a misbehaving check cannot strand the operator.
4. Add src/lib/clock-check.test.ts covering threshold boundaries, no-source-reachable path, and abort/timeout behaviour.
5. Split the 2027 calendar updates into their own commit (or a separate worktree). Keeps the merge unit focused.
6. Author the lesson file at docs/lessons/2026-04-24-clock-skew-detection.md per CLAUDE.md's mandatory workflow.
7. Tighten NTP timeout to ~2-3s so a slow time source does not add seconds to every backend boot.

## Files reviewed

- /Users/jason/Workspace/trade-follower-3/.claude/worktrees/inspiring-poitras-be27c7/src/lib/clock-check.ts
- /Users/jason/Workspace/trade-follower-3/.claude/worktrees/inspiring-poitras-be27c7/src/index.ts
- /Users/jason/Workspace/trade-follower-3/.claude/worktrees/inspiring-poitras-be27c7/src/lib/et-date.ts
- /Users/jason/Workspace/trade-follower-3/.claude/worktrees/inspiring-poitras-be27c7/src/broker/ibkr/schemas.ts
- /Users/jason/Workspace/trade-follower-3/.claude/worktrees/inspiring-poitras-be27c7/sidecar/src/main/java/com/tradefollower/sidecar/App.java
- /Users/jason/Workspace/trade-follower-3/.claude/worktrees/inspiring-poitras-be27c7/sidecar/src/main/java/com/tradefollower/sidecar/TwsBridge.java
- /Users/jason/Workspace/trade-follower-3/.claude/worktrees/inspiring-poitras-be27c7/src/lib/alert.ts (for sendSystemAlert signature)

## Reviewer verdict

**Concur with REWORK.** Attempted to falsify; the thesis's central claim holds up against the code.

### Verified claims

1. **IBKR-skew staleness trap is real.** `TwsBridge.HEARTBEAT_INTERVAL_MS = 30_000` and `lastIbkrServerTimeMs` is only written in the `currentTime(long time)` callback (line 447), fired by the watchdog calling `client.reqCurrentTime()` every 30s on tick. There is no local-receive-timestamp field exposed on `/status`; the TS side has no way to compensate for staleness. `Date.now() - ibkrServerTimeMs` samples uniformly in [0, 30_000)ms once the heartbeat has warmed up, which deterministically trips the 2000ms FATAL threshold roughly 93% of the time. The author's own comment ("inherently coarse… use it only to detect gross skew (> WARN_THRESHOLD)") is inconsistent with the thresholds actually coded. This is the exact "false-positive theatre" pattern the rubric warns about, compounded by being a *blocking* throw.

2. **Minor refinement on the trap trigger window.** On a fresh sidecar restart, `lastIbkrServerTimeMs` starts at 0 and is filtered (`if (!data.ibkrServerTimeMs) return null`), so the first `checkClockSkew(sidecarUrl)` call within ~30s of sidecar boot is safe. The trap actually springs on backend restarts against a *long-running* sidecar — which is the common operational case (sidecar is a separate Java process, restarted less often than the TS backend). So the thesis's "guaranteed" framing is slightly strong, but the practical impact stands.

3. **Detect-vs-correct rubric.** The code does not try to set the OS clock — good. But it blocks backend startup via `throw`, which is a fix-by-refusal and, combined with (1), is a boot-loop waiting to happen. Detect-and-alert would be alert + continue, or alert + throw only when gated by an env flag.

4. **et-date.ts changes**: pure appends to existing `MARKET_HOLIDAYS` and `MARKET_EARLY_CLOSES` sets. No date-math duplication in `clock-check.ts`. Dates spot-checked (2027-04-02 Good Friday, 2027-07-05 observed Independence Day, 2027-12-24 observed Christmas) — correct. Scope-creep concern is valid but the change itself is clean.

5. **Java sidecar changes**: tiny and on-topic. `TwsBridge.currentTime()` already ran; adding `lastIbkrServerTimeMs = time * 1000L` and exposing via `getLastIbkrServerTimeMs()` on `/status` is surgical. The fix for concern (1) would be to *also* expose `lastIbkrServerTimeReceivedAtMs` (the local clock at callback fire) — the sidecar already has this info implicitly (it writes `lastHeartbeatResponse` on the same line), it just isn't plumbed out.

6. **Missing lesson file**: confirmed. `docs/lessons/2026-04-24-*.md` contains four unrelated files; no clock-skew entry.

7. **No tests**: confirmed. No `src/lib/clock-check.test.ts`.

### Additional concern not in thesis

`src/index.ts:44-46` hard-codes a single sidecar URL (live > paper > localhost fallback), but `runtime-channels.ts` allows per-channel sidecar URLs. If a future setup ran both live and paper channels on distinct sidecars, only one would be checked. Low priority.

### Net

Thesis verdict (REWORK) and required-fixes list are accurate and appropriately scoped. Merging as-is would likely strand the operator on first post-heartbeat startup. The fix is small (plumb `lastIbkrServerTimeReceivedAtMs` through, compensate for staleness, or delete the IBKR check and lean on NTP) but mandatory before going live.

Path: /Users/jason/Workspace/trade-follower-3/.claude/worktree-review/inspiring-poitras-be27c7.md
