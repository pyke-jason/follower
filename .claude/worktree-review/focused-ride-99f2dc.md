# Worktree Audit — `focused-ride-99f2dc` (Observability Audit)

## Goal

Pre-live observability sweep: ensure incidents (rejected orders, hung LLM, broker outages, partial fills, drift) can be reconstructed from logs alone. No new metrics infrastructure — just turn up the dial on existing pino logs, fix a silent root-level bug, and add a single ops snapshot endpoint.

## Changes

1. **`src/lib/logger.ts`** — Set pino root level to `'debug'`; rely on per-stream level gates (`prettyStream` at `initialLevel`, file stream at `'debug'`).
2. **`src/trades/record-trade.ts`** — All six lifecycle events (OPEN, CLOSE, ADD, TRIM, LEG_OFF auto, LEG_OFF, CANCEL) lifted from `log.debug(...)` → `log.info({...structured fields}, "...")`.
3. **`src/orders/order-manager.ts`** — Added `Submit` info log; added structured fields and `qty` to existing Fill log; added REJECTED `log.error` in two paths (sync `submitOrder` rejection; async `tick` rejection); enriched Auto-cancel log with `adjustmentCount`.
4. **`src/pipeline/execute-resolved.ts`** — Added `messageId` to the canonical execution log (string + structured field); added REJECTED `log.error` in OPEN and CLOSE paths.
5. **`src/agent/anthropic-agent.ts`** — Added bookend logs at LLM call start/end with `model`, `durationMs`, token counts, `costUsd`.
6. **`src/broker/ibkr/client.ts`** — Wrapped `sidecar()` HTTP helper to log every request (debug on success, warn on non-2xx or fetch failure) with `path`, `method`, `status`, `durationMs`. Added Placed info log in `placeOrder` with `orderId`, IBKR + mapped status, `limitPrice`, leg count.
7. **`src/live/runner.ts`** — Converted four `console.log/warn` calls to structured `log.info/warn`. Added `durationMs` to "Task done".
8. **`src/lib/circuit-breaker.ts`** — Converted three `console.warn/error/log` to structured pino. Added `consecutiveFailures` field to OPEN log.
9. **`src/local-api/routes/ops-status.ts`** (new) — Hono route that runs seven parallel reads (open trades grouped by channel, unresolved recon alerts, runtime health rows, today's task counts, today's equity, last-hour failed tasks, unresolved orphan fills) and returns a single JSON snapshot.
10. **`src/local-api/server.ts`** — Mounts `/ops-status`.
11. **`docs/ops-queries.md`** (new) — Ten copy-paste SQL queries plus log/curl one-liners for on-call.

## Justification per change

**1. Logger root level (CRITICAL — JUSTIFIED).** This is a real bug, not theatre. With pino multistream, root `level: 'info'` filters records before they reach the file stream's `level: 'debug'`, so the file stream's lower level is silently inert. Setting root to `'debug'` and letting per-stream levels filter is the documented pino pattern. Necessary for going live because the file sink is the primary forensic tool (3am incident → next morning grep). However: this exposes a side effect — `setLogLevel(level)` (called from `backtest/launch.ts` and `classify/launch.ts` for `--log-level debug`) now only mutates `root.level`, not the prettyStream gate. So `--log-level debug` will no longer enable debug output to terminal at runtime, since prettyStream's level is fixed at module-load from `LOG_LEVEL` env. Minor concern, not a blocker.

**2. record-trade lifecycle to info (JUSTIFIED with concern).** Trade lifecycle events at debug were genuinely invisible at the default level. Lifting to info gives the on-call basic ground truth ("did the bot open this trade? when?"). HOWEVER: the same `recordTrade` runs in backtest, where a multi-month run will now emit thousands of info lines that previously didn't appear. Test output already shows this flooding the console during sim-broker tests. The lesson file acknowledges this risk in section A but the fix isn't gated on environment — backtest noise is real. Acceptable for live use; mildly painful for backtest runs. Per rails (no `if (isBacktest)` in pipeline), per-environment gating belongs at the caller, which is what `setLogLevel` exists to do — but see issue #1; that's now partially broken.

**3. order-manager Submit/Fill enrichment + REJECTED error (JUSTIFIED).** The pre-state had ZERO log of what the broker was asked to do — only the Fill on completion. For a system going live, "what did we send?" is a non-negotiable forensic field. `legSummary`, orderType, and limitPrice are all sub-50-byte adds. Fill log gaining structured `qty/commission` is real — partial fills become greppable.

**4. execute-resolved enrichment (PARTIALLY JUSTIFIED — DUPLICATION CONCERN).** Adding `messageId` to the executor's authoritative log line is the highest-leverage single change in the diff: it ties the chat-message → DB-trade chain together. Justified.

HOWEVER: the REJECTED error log is duplicated. A single rejected order can now log `error` at:
- `order-manager.ts:62-64` (synchronous rejection on `submitOrder`)
- `execute-resolved.ts:567` or `:626` (caller of `placeOrder`)
- `order-manager.ts:127` (async rejection in `tick`)

For a synchronous reject, both `order-manager.ts:62-64` AND `execute-resolved.ts:567` fire. This is the "logging duplicated across multiple call sites instead of factored" pattern the audit was supposed to catch. The producer (`order-manager`) should own the REJECTED log; the consumer (`execute-resolved`) shouldn't repeat it. Or vice versa — but pick one.

**5. AnthropicAgent timing/usage (JUSTIFIED — but upstream concern).** Genuinely useful for live: LLM calls are the most opaque latency contributor. Bookend logs let you spot 6-hour hangs (no "done" → process killed) and cost overruns. Two upstream concerns:
- The lesson file admits: "Hung LLM = runner task stuck in IN_PROGRESS forever until circuit breaker triggers." A `timeoutMs` on `Agent.run()` would actually fix the hang; bookend logs only let you observe it after the fact. Adding `signal: AbortSignal` to `AgentRunOptions` at the `Agent` base interface is the upstream-enough version.
- This is added in `AnthropicAgent` only. If `XAIAgent` is selected by the factory, it still has no timing log. Per the rubric, telemetry on a polymorphic interface belongs at the boundary or in a shared helper, not duplicated in N implementations. Single-implementation-touch is okay for pre-live signal; mark as future work.

**6. IBKR sidecar logger (JUSTIFIED).** Zero TS-side logging of sidecar HTTP requests was a real gap — orders flow through `sidecar()` but only the Java side recorded them. Wrapping the helper (one place, all callers benefit) is exactly the right factoring level. Debug on success keeps live noise low; warn on failure surfaces issues. Placed log adds orderId+ibkrStatus+mappedStatus, which is the link between "we sent an order" and "broker accepted it with this server-side ID". Right level (info).

**7. runner.ts console→pino (JUSTIFIED).** `console.log/warn` bypasses pino entirely → no file sink, no JSON, ungreppable. Tasks are the unit of work; "Task start/done" with `taskId/channelId/durationMs` is core forensic data. Justified. (Note: many other files in `src/ingestion/`, `src/live/factory.ts`, `src/local-api/server.ts` still use `console.*`. The audit picked off the runner + circuit-breaker but left the rest. Inconsistent but not in scope to fix here.)

**8. circuit-breaker console→pino (JUSTIFIED).** Same rationale. Circuit OPEN events MUST be in the file sink — they explain why trades didn't fire.

**9. /ops-status endpoint (JUSTIFIED but borderline).** This is the kind of "metrics endpoint that nobody will scrape" the rubric warns about. BUT: it's not a Prometheus scrape target — it's a curl-friendly snapshot for the human on call, paired with the `docs/ops-queries.md` SQL one-liners. The endpoint is one Hono route, ~120 lines, runs seven parallel reads against existing tables — no new schema, no new infrastructure. Single-user-appropriate (it's on `localhost:3791` with no auth, which is fine because the local-api is local-only). Minor concerns: filters `'bt:%'` channels (good); doesn't paginate `recentErrors` beyond 10 (acceptable); SQL uses `gte(tasks.createdAt, today)` where `today` is the date prefix `'2026-04-24'` and `createdAt` is an ISO-8601 timestamp string — lexicographic compare is correct here but worth noting. Acceptable bloat.

**10. ops-queries.md (JUSTIFIED).** Documentation of useful one-liners is cheap. The CLI section's `jq` filter on `level: 50` for "REJECTED orders today" only works because the new code logs REJECTED at `error` (level 50) — so the docs and code are consistent.

## Concerns

1. **Backtest log volume.** Lifting six `recordTrade` calls from debug → info will flood backtest console output. Already visible in the test run (every CLOSE prints `{ tradeId, symbol, exit, closePnl, totalPnl, channelId }` to terminal). Backtest already calls `setLogLevel('info')` by default so users have no convenient escape. NOT a blocker for live.

2. **Duplicate REJECTED logs.** As noted, a single reject can fire `log.error` from two layers (`order-manager` + `execute-resolved`). This is exactly the "logging duplicated across multiple call sites" pattern the audit was supposed to catch.

3. **`setLogLevel` semi-broken.** With root.level fixed at `'debug'`, calling `setLogLevel('debug')` from `--log-level debug` no longer enables debug output to the terminal because the prettyStream gate is captured at module-load time from `LOG_LEVEL` env. The runtime log-level mutator is now effectively a no-op for the prettyStream. Acceptable post-launch (`LOG_LEVEL` env at start works), but warrants a follow-up: either rebuild the multistream when level changes, or wire the prettyStream level through `setLogLevel`.

4. **No `Agent.run()` timeout.** The lesson file calls this out as a remaining gap. An LLM hang is a real production risk; bookend logs let you observe it but the runner task still hangs in IN_PROGRESS forever until the staleness sweep or circuit breaker kicks in. Out of scope here; should be tracked.

5. **AnthropicAgent change vs XAIAgent.** Timing/usage log added only to one implementation. Either factor into a shared `runWithTelemetry()` wrapper at the `Agent` interface or accept that XAI calls won't show up in latency analyses. Minor.

6. **`/ops-status` no auth.** Acknowledged in lesson file. Localhost-only is acceptable for single-user pre-launch. Fine.

7. **`ibkr/client.ts` import placement is ugly.** `const log = createLogger('IBKR');` is inserted between two import blocks (between `import { withRetry, ... }` and `import { randomUUID }`). TypeScript allows it but it's a code-style smell; the const should be after the last import.

## Verdict

**MERGE with minor rework.** The core observability gaps were real, and the fixes are the right shape: one canonical pino root level, lifecycle events at info with structured fields, factor-once helpers (the sidecar wrapper, the per-file `createLogger` calls), structured `messageId` correlation through the pipeline. The diff is small (~90 lines net), touches the right files, and the lesson file is honest about remaining gaps. The REJECTED log duplication and the `setLogLevel` runtime no-op are real but minor — neither blocks going live; both can be cleaned up in a follow-up. The `/ops-status` route is borderline but cheap and useful for on-call. Recommend merging after the required fixes below.

## Required fixes (before merge)

1. **De-duplicate REJECTED logs.** Pick `execute-resolved.ts` (has `messageId`) OR `order-manager.ts` (has nothing extra). Remove the other. The `tick`-path REJECTED in `order-manager.ts` is reachable only for async-rejected orders that were initially OPEN, so it stays — but the synchronous-path duplicate at `order-manager.ts:62-64` overlaps with `execute-resolved.ts:567`. Drop the order-manager synchronous one (or drop both `execute-resolved` REJECTED logs and add `messageId` plumbing into order-manager via a logging context — heavier, not recommended pre-live).
2. **Move the IBKR `const log` declaration below all imports** in `src/broker/ibkr/client.ts` (cosmetic but distracting).

## Recommended follow-ups (not blocking)

- Plumb `signal: AbortSignal` + timeout through `AgentRunOptions` at the `Agent` interface (the upstream-enough fix the rubric calls out).
- Factor the LLM bookend telemetry into a shared `runWithTelemetry(agent, opts)` so XAI gets it free.
- Fix `setLogLevel` so the prettyStream gate honours runtime level changes (rebuild multistream, or expose a setter).
- Decide whether backtest should down-level `record-trade` lifecycle logs (gate via `setLogLevel` from launch; do NOT branch on env inside `record-trade.ts`).
- Add `find .logs -name '*.log' -mtime +30 -delete` cron for log retention (lesson file acknowledges).

## Reviewer verdict

**Thesis holds; extend required fixes.** Tried to falsify and mostly couldn't — every claim in the thesis verifies against the diff. Extending with findings the thesis soft-pedaled or missed.

**Confirmed:**

1. REJECTED duplication is real. Synchronous passthrough (MARKET or LIMIT-no-rules) goes `order-manager.ts:62-64` → returns to `execute-resolved.ts:567` — both fire `log.error`. For any live market-order reject you get two error lines with different structured shapes. Thesis-correct.
2. `setLogLevel` is semi-broken. `root.level = level` at logger.ts:107 mutates only the root; the prettyStream gate at line 101 is fixed at module-load from `LOG_LEVEL` env. Both `src/backtest/launch.ts:74` and `src/classify/launch.ts:46` call `setLogLevel(...)` after the fact — now silently a no-op for terminal output.
3. Ugly import in `src/broker/ibkr/client.ts:13-16` — `const log = createLogger('IBKR')` sits between two import blocks. Cosmetic but jarring.
4. `/ops-status` has no programmatic consumer. `grep` across `web/` and scripts returns zero hits; only `docs/ops-queries.md` has a curl one-liner. That's fine if framed as a human curl endpoint (thesis does), but it does tip toward "metrics endpoint nobody scrapes" — no frontend widget, no cron'd alert. Borderline, not blocker.

**Thesis under-called — add as required fix:**

5. **REJECTED logs are silent to the operator.** Both new `log.error` sites write to file + stdout only. Circuit-breaker OPEN routes to `sendAlert` (deps.sendAlert in circuit-breaker.ts:102); rejected orders do NOT. For a system going live *tomorrow*, a live-account order reject is a notify-the-human event, not a grep-the-logs event. At minimum the `execute-resolved.ts` reject paths should `sendAlert({severity: 'warning'})` alongside the log. This is bigger than the de-dup concern — the de-dup is noise; the no-alert is a silent failure mode.
6. **LLM call bookend log uses wrong pairing discipline.** `AnthropicAgent.run()` logs start unconditionally but "done" only at successful return — if the SDK throws mid-stream, you get start with no done and no structured error line (the catch at line 118 in the SDK iterator sets `hadFault` but no error log). Hung LLM is detectable; *thrown* LLM leaves a half-open trace with no level-50 record. Add a try/finally around the run so every start has a matched done/error.

**Concerns that aren't blockers** (thesis already flagged): backtest flood from `record-trade` info lifts, XAI vs Anthropic telemetry asymmetry, no `Agent.run()` timeout.

**Duplication audit verdict**: the thesis feared shape-repeated logging across 6 files; in practice each file's `log.xxx({structured}, msg)` shape is consistent and the `createLogger('Tag')` pattern is already a factored helper. The one real duplication is the REJECTED path (items 1 and 5 above). No "six copies of the same timing wrapper" pattern — thesis fear falsified.

**Silent-metrics audit verdict**: `/ops-status` reads real tables that are written to elsewhere (trades, recon alerts, runtime_health, tasks, daily_balances, orphan_fills). Data is live, not theatre. Consumer is only human curl, which is acceptable for single-user single-day pre-launch.

**Verdict: MERGE after fixes 1, 5, 6.** Fix 1 is trivial (drop one of the two REJECTED sites). Fix 5 is the load-bearing one — add `sendAlert` on reject or this whole audit punts the highest-severity live event to log-grep. Fix 6 is a five-line try/finally. Rest can be follow-ups.
