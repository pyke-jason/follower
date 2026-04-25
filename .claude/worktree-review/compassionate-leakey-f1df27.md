# compassionate-leakey-f1df27

## Goal
Harden the alert/notification path for live trading. Three concrete pre-live gaps: (1) the `alertedMissingSubscription` `Set<string>` permanently silenced any symbol after its first 402 alert (process-scoped, never reset, no decay), (2) `AnthropicAgent.run()` and `XAIAgent.run()` had no timeout — a backtest had stalled six hours on a hung LLM call, (3) several critical failure modes (sidecar unreachable, order rejection, slow `getAccountBalance`, low margin cushion, DB write failure) had no alert path. The author introduces `src/lib/alert-dedup.ts` as a centralized rate-limiter (10-minute window keyed by error class with critical-always-fires-once-per-window escalation), wires it in at existing alert callsites, adds 5-minute timeouts on both agent impls, and adds a `withDbFailureAlert` wrapper around every `runTx` in `record-trade.ts`.

## Changes
- `src/lib/alert-dedup.ts` (new) — `shouldSuppress(errorClass, severity)` rate limiter with 10-min window + critical sub-window.
- `src/lib/alert-dedup.test.ts` (new) — 10 unit tests covering first-fire, in-window suppress, window expiry, critical escalation, key independence, reset.
- `scripts/test-alerts.ts` (new) — manual end-to-end smoke test via `sendSystemAlert`. Wired as `npm run alerts:test`.
- `src/agent/anthropic-agent.ts` — wraps the message-stream `for await` in a `Promise.race` against a 5-minute timeout; on timeout fires a critical alert and rethrows.
- `src/agent/xai-agent.ts` — passes an `AbortSignal` from a 5-minute setTimeout to `generateText`; on abort fires the same critical alert.
- `src/broker/ibkr/client.ts` — replaces `alertedMissingSubscription` Set with `shouldSuppress`; adds sidecar-unreachable alert in `sidecar()` helper, order-rejection alert in `placeOrder().catch()`, slow-balance alerts (warn 5s / critical 30s) and margin-cushion alerts (warn <25% / critical <10%) in `getAccountBalance`.
- `src/trades/record-trade.ts` — defines local `withDbFailureAlert(label, fn)`; wraps all six `runTx` calls (OPEN, LEG_OFF auto, CLOSE, ADD, TRIM, LEG_OFF, recordCancelledOpen).
- `package.json` — adds `alerts:test` script.

## Justification per change
- `src/lib/alert-dedup.ts` — JUSTIFIED — Real fix for a real bug; ~50 LOC, one canonical home, used at multiple callsites. Critical sub-window matches the design need (warn-then-critical must escalate even within a window).
- `src/lib/alert-dedup.test.ts` — JUSTIFIED — Tests the suppression contract (window expiry, critical escalation, key independence). Not theatre.
- `scripts/test-alerts.ts` + `package.json` — JUSTIFIED — One-shot smoke test for end-to-end alert wiring before going live; trivial, clearly labeled, no API surface.
- `src/broker/ibkr/client.ts` (sidecar unreachable, 402 dedup migration, slow balance, margin cushion) — JUSTIFIED — Each alert maps to a specific operational failure mode the user must hear about in real time. The 402 migration from `Set` to `shouldSuppress` is a strict bug fix. Margin/slow-balance are IBKR-specific (cushion is optional on the type, not present in SimBroker), correctly placed in the impl.
- `src/broker/ibkr/client.ts` (order rejection alert) — SUSPECT — TWS code regex is duplicated verbatim from `ibkrClassify` at line 122. Should reuse a shared `parseTwsCode(msg)` helper.
- `src/agent/anthropic-agent.ts` + `src/agent/xai-agent.ts` — REWORK — The 5-minute timeout is necessary, but the impl duplicates the constant, the alert payload (`title: 'LLM agent timed out'`, severity, `model` field), and the post-timeout handling across both files. The audit rubric example calls this exact pattern out as REWORK. Belongs at the `Agent` interface boundary — wrap once in `createAgent` or in a shared `withAgentTimeout(run, ms)` helper.
- `src/trades/record-trade.ts` — SUSPECT — `withDbFailureAlert` is the right shape, but it does NOT call `shouldSuppress`. A real DB outage will fire one critical alert per failing trade write — exactly the cascade-spam pattern this PR was written to prevent.

## Concerns

- **Not upstream enough**: Agent timeout duplication across `src/agent/anthropic-agent.ts:22-23,127-149` and `src/agent/xai-agent.ts:26,65-93`. Same constant, same alert payload, same policy, two implementations. Belongs at the `Agent` interface boundary (decorate in `createAgent`, or extract a shared `withAgentTimeout`/`runWithTimeout` helper). The audit rubric cites this exact pattern.

- **Bloat / inconsistency**: `withDbFailureAlert` at `src/trades/record-trade.ts:26-37` skips the dedup primitive added in the same PR. A DB outage during live trading would emit one critical alert per failed `runTx`.

- **Bloat (minor)**: TWS-code regex duplicated at `src/broker/ibkr/client.ts:122` (`ibkrClassify`) and `src/broker/ibkr/client.ts:341` (new `placeOrder` catch). Extract `parseTwsCode(msg): number | null`.

- **Theatre (very minor)**: `placeOrder().catch()` block at `src/broker/ibkr/client.ts:339-357` puts rejection-detection logic in two places (the classifier decides retry, the catch decides alert). One TWS-code table keyed by code → `{ retryable, alertable, label }` would be cleaner. Not a blocker.

## Verdict
**REWORK** — The diagnosis is correct and the changes address real pre-live gaps. `alert-dedup.ts` is well-designed and well-tested. Two items pull this back from MERGE: (a) agent timeout is implemented twice in parallel when it belongs at the `Agent` boundary — the audit prompt called this out as the canonical REWORK example; (b) `withDbFailureAlert` doesn't use the dedup primitive that the same PR added, so a DB outage will spam. Both fixes are mechanical. Once they land, the worktree is mergeable.

## Required fixes
1. Extract a shared agent-timeout wrapper. Either decorate the returned `Agent` in `src/agent/factory.ts:15-30` so `run` is wrapped once at the boundary, or add `src/agent/with-timeout.ts` exporting `withAgentTimeout(run, { timeoutMs, model })`. Remove the duplicated `AGENT_TIMEOUT_MS` and `sendSystemAlert` from `src/agent/anthropic-agent.ts:22-23,127-149` and `src/agent/xai-agent.ts:26,65-93`. The wrapper should accept an optional `AbortController` so xAI can pass it into `generateText({ abortSignal })`; Anthropic falls back to `Promise.race` since the SDK has no cancellation API.
2. `src/trades/record-trade.ts:26-37` — call `shouldSuppress('db.write_failure', 'critical')` inside `withDbFailureAlert` before `sendSystemAlert`. Optionally accept an explicit `errorClass` arg so each callsite (`'db.write_failure.OPEN'`, etc.) gets its own dedup slot.
3. `src/broker/ibkr/client.ts:339-357` — extract the duplicated TWS code regex (`/IBKR error (\d+)/i` ?? `/error[:\s]+(\d{3,4})/i`) into a shared `parseTwsCode(msg)` helper used by both `ibkrClassify` (line 122) and the `placeOrder` catch (line 341).

## Reviewer verdict
**REWORK** — All three concrete claims verify exactly as written; the thesis is calibrated and the diagnosis correct. `alert-dedup.ts` is well-scoped and its tests pass (10/10). `tsc --noEmit` is clean. The two structural defects called out (shared timeout wrapper; dedup-in-`withDbFailureAlert`) are real and mechanical; both should land before live use.

### Agreements
- **Agent timeout duplication (lines claimed):** verified at `src/agent/anthropic-agent.ts:22-23,127-149` and `src/agent/xai-agent.ts:26,65-93`. Same `AGENT_TIMEOUT_MS = 5 * 60_000`, same `title: 'LLM agent timed out'`, same severity, same `model` field, same "Task will fail — check X_API_KEY and network" copy. `createAgent` in `src/agent/factory.ts` is the obvious wrap point (15 LOC, already the construction boundary).
- **`withDbFailureAlert` skipping dedup:** verified at `src/trades/record-trade.ts:26-37`. Seven callsites (OPEN, LEG_OFF-auto, CLOSE, ADD, TRIM, LEG_OFF, recordCancelledOpen) each bypass `shouldSuppress`. A real Postgres outage during a burst of trades would produce N critical alerts per flush — the exact anti-pattern the PR centralizes elsewhere.
- **TWS regex duplication:** verified at `src/broker/ibkr/client.ts:122` (classifier) and `:341` (placeOrder catch), nearly-identical regexes. Extracting `parseTwsCode(msg): number | null` is a 5-line fix.

### Disagreements
None material. The "keyword-in-message" abort detection at `xai-agent.ts:84` uses `abortController.signal.aborted` (not message regex), which is slightly cleaner than Anthropic's `/timed out/i.test(err.message)` — but thesis already says both belong in one wrapper, so this is mooted.

### Missed by thesis
- **`sendSystemAlert` proliferation is broader than flagged.** 40+ callsites across `ingestion/`, `reconciliation/`, `browser.ts`, `battery-monitor.ts`, `expiry-warning.ts`, `server.ts`, `live/runner.ts` still fire raw alerts without `shouldSuppress`. The PR only deduped ibkr client + (partially) the agent paths. Not a blocker for this PR's scope, but the dedup primitive's value is unrealized until those callsites adopt it — worth a follow-up issue.
- **Critical-sub-window semantics edge case.** `shouldSuppress` always updates `lastFiredAt = now` on the first critical in a warning-claimed window (`alert-dedup.ts:45`), which resets the window for subsequent warnings too. Likely intentional but not tested; benign.
- **`withDbFailureAlert` wrapper is inside-the-transaction boundary.** Each wrapped call includes the whole `runTx(async tx => ...)` body. If the inner function throws a non-DB error (e.g. domain validation after a successful insert attempt), it still fires a "DB write failure" alert. Label is misleading in that path; consider catching only `Error` instances whose message indicates DB failure, or rename the label.

### Verdict reasoning
Changes fix real pre-live alert gaps and the dedup primitive is solid. Two structural defects (agent timeout duplication; withDbFailureAlert bypassing dedup) are genuine rails violations called out by `.claude/rules/lessons.md` ("shape-plumbing cruft" / canonical home). Both fixes are small. REWORK is correct: do not merge until (a) agent timeout is wrapped once in `createAgent` or a `with-timeout.ts`, (b) `withDbFailureAlert` calls `shouldSuppress('db.write_failure', 'critical')`, and ideally (c) the TWS regex is extracted.
