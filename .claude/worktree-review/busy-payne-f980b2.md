# busy-payne-f980b2

## Goal
Plug pre-live test-coverage gaps in the four critical paths (`OrderManager`, `checkRiskLimits`, `Reconciler`, `FillSweep`) and add wall-clock timeout protection so a hung LLM request can no longer silently block the pipeline. The lesson file frames it as "tests + the minimum production-code surgery to make those tests possible": export `ibkrClassify` for white-box tests, and wrap `Agent.run()` in `Promise.race` with a default 120 s timeout.

## Changes
- `src/agent/result.ts` — add `timeoutMs?: number` to `AgentRunOptions`.
- `src/agent/anthropic-agent.ts` — split `run()` into a public `Promise.race` timeout shell + `_run()` worker (120_000 ms default).
- `src/agent/xai-agent.ts` — identical split and identical default.
- `src/broker/ibkr/client.ts` — promote `ibkrClassify` from private to `export` (tagged `@internal`) for testing.
- `src/broker/ibkr/client.test.ts` — add 7 classification cases (402, 503, ECONNREFUSED, TWS 504/201/10197, unknown fallback).
- `src/agent/timeout.test.ts` (new) — 4 cases; one drives real `AnthropicAgent` with a mocked SDK that hangs.
- `src/orders/risk-check.test.ts` (new) — 17 pure-function cases covering CLOSE/TRIM bypass, position cap, notional cap, drawdown, recon-alert block, 30 s duplicate-OPEN window.
- `src/orders/order-manager.test.ts` (new) — 8 cases using `manualTick: true` + mock broker: cancel/fill race, batched price-chase steps, chase ceiling, exposure, `exportState`/`restoreState`.
- `src/reconciliation/reconciler.test.ts` (new) — 6 DB-backed cases (BROKER_ONLY detect/persist/dedup/auto-resolve, DB_ONLY, no-discrepancy).
- `src/reconciliation/fill-sweep.test.ts` (new) — 5 DB-backed cases for restart-recovery.
- `package.json` — add `test:live-readiness` verbose-reporter script listing the seven files.
- `docs/lessons/2026-04-24-live-readiness-test-coverage.md` (new) — rationale.

Quality gates: `tsc --noEmit` clean; all 55 new + modified tests pass locally.

## Justification per change
- `src/agent/result.ts` (`timeoutMs` option) — JUSTIFIED. Per-call override belongs on the shared interface.
- `src/agent/anthropic-agent.ts` + `src/agent/xai-agent.ts` (timeout wrappers) — SUSPECT. Real need (live path currently has no timeout; `llm-path.ts:264` calls `agent.run()` unprotected while only `BacktestAgent` wraps it). But the 8-line `Promise.race` shell is duplicated verbatim across both providers when the `Agent` interface has one method and `BacktestAgent` already contains a proper `withTimeout<T>` helper (`src/backtest/backtest-agent.ts:19-31`) that even calls `clearTimeout`. The new inline wrappers don't clear the timer, leaking an unfired 120 s handle on every fast call.
- `src/broker/ibkr/client.ts` (`export ibkrClassify`) — JUSTIFIED.
- `src/broker/ibkr/client.test.ts` (7 new cases) — JUSTIFIED. TWS 10197 (competing session) misclassification is a real go-live risk.
- `src/agent/timeout.test.ts` (4 cases) — MOSTLY JUSTIFIED. The "AnthropicAgent integration" case is real. The two `makeHangingAgent` cases re-implement production's `Promise.race` inside the test and then assert the re-implementation works — circular. The "default timeoutMs is 120_000" test name lies (it just asserts a 100 ms explicit override fires fast).
- `src/orders/risk-check.test.ts` (17 cases) — JUSTIFIED. Exactly the coverage that was missing pre-live.
- `src/orders/order-manager.test.ts` (8 cases) — JUSTIFIED. `manualTick: true` avoids wall-clock reliance; cancel/fill race is a real production concern.
- `src/reconciliation/reconciler.test.ts` (6) + `src/reconciliation/fill-sweep.test.ts` (5) — JUSTIFIED. Reconciliation is the live-trading safety net; restart recovery via FillSweep is a known critical path.
- `package.json` `test:live-readiness` script — BLOAT. `npm test` already runs these files; the curated script is an audit-convenience with no CI wiring.
- `docs/lessons/…` — JUSTIFIED (project convention).

## Concerns
- **Not upstream enough:** `src/agent/anthropic-agent.ts:43-51` and `src/agent/xai-agent.ts:43-51` duplicate the same 8 lines. Correct home: `withAgentTimeout(agent)` decorator applied inside `src/agent/factory.ts:createAgent()`, reusing/extending the existing `withTimeout<T>` in `src/backtest/backtest-agent.ts:19-31`.
- **Resource leak:** neither new wrapper calls `clearTimeout` (the existing helper in `backtest-agent.ts:20-30` does). Fast resolves leak an unfired 120 s timer, keeping the event loop alive and blocking clean shutdown.
- **Bloat:** `package.json:24` `test:live-readiness` duplicates what `npm test` already runs.
- **Theatre:** `src/agent/timeout.test.ts:13-30` `makeHangingAgent` + its two tests (lines 41-72) assert that the test's own `Promise.race` scaffolding works. The misnamed "default 120_000" case (lines 64-71) asserts nothing about the default.

## Verdict
**REWORK** — all the new tests are valuable and all pass. The production change addresses a real live-pipeline gap, but it lives in the wrong place (duplicated across both providers, leaking timers) when `createAgent()` / a shared `withTimeout` helper is the upstream answer. Promote the helper, drop the `_run()` split, fix the timer leak, delete the audit-only script and the two scaffolding-only timeout tests, then MERGE.

## Required fixes (REWORK)
1. Delete the `run()` shell + `_run()` rename in `src/agent/anthropic-agent.ts:43-53` and `src/agent/xai-agent.ts:43-53`; restore original `async run(opts) { … }`.
2. Extend `src/backtest/backtest-agent.ts:19-31`'s existing `withTimeout<T>` into `src/agent/with-timeout.ts` and apply it inside `src/agent/factory.ts:createAgent()` for both providers (OR add a `withAgentTimeout(agent, 120_000)` decorator at the factory). The wrapper MUST `clearTimeout(timer)` in `finally`.
3. Keep `timeoutMs` on `AgentRunOptions` (`src/agent/result.ts:47`) — no change there.
4. No change required at `src/intents/orchestrator/llm-path.ts:264` once (2) is done at factory level.
5. Delete the `test:live-readiness` script from `package.json:24`.
6. In `src/agent/timeout.test.ts`, delete the two `makeHangingAgent` cases (lines 41-72) and the misnamed default-timeout case. Keep the `AnthropicAgent — timeout integration` block and add a parallel `XAIAgent — timeout integration` that mocks `@ai-sdk/xai`'s `generateText` to hang.

## Reviewer verdict
**REWORK** — I agree with the thesis overall. The tests are genuinely valuable, the timeout need is real, but the production change was dropped in the wrong place and leaks a timer. Two additional nits were missed, listed below.

### Agreements
- Timer leak in `src/agent/anthropic-agent.ts:43-51` and `src/agent/xai-agent.ts:43-51` is real: neither `Promise.race` clears the `setTimeout`, so fast resolves keep a 120s timer pending and block clean Node exit. The already-existing `withTimeout<T>` at `src/backtest/backtest-agent.ts:19-31` does `finally { clearTimeout }` correctly — the right pattern is sitting 200 lines away, unused.
- `test:live-readiness` in `package.json:24` is pure audit bloat — `npm test` already runs all seven files.
- `src/agent/timeout.test.ts:13-30` `makeHangingAgent` is self-testing scaffolding. Its body re-implements the production `Promise.race` pattern, then two tests (lines 41-47, 64-71) assert that the test's own re-implementation works. Circular. The "default timeoutMs is 120_000" name at line 64 is a lie — the body passes an explicit `timeoutMs: 100`.
- Exporting `ibkrClassify` with `@internal` for white-box tests is justified; the 10197 "competing session" case at `src/broker/ibkr/client.test.ts:177-182` prevents a real retry-loop regression.
- The `checkRiskLimits`, `OrderManager`, `Reconciler`, and `FillSweep` test suites all exercise real behavior (cancel/fill race, batched chase, BROKER_ONLY dedup/auto-resolve, restart adoption of in-flight orders) — not scaffolding.

### Disagreements
- None material. The thesis's REWORK disposition is correct.

### Missed by thesis
- **AnthropicAgent integration test leaks module-level mock state.** `src/agent/timeout.test.ts:77-82` uses a bare `vi.mock('@anthropic-ai/claude-agent-sdk', …)` inside a `test()` body. `vi.mock` is hoisted module-wide; placing it inside a test creates a race with other tests in the same worker that import the real SDK. Move it to module top or use `vi.doMock` with an explicit `vi.resetModules()`.
- **Missing `@src/*` alias usage.** `src/orders/risk-check.test.ts:7-9` and several other new test files use relative imports (`./risk-check.js`, `../broker/interface.js`). Not a rails violation (backend uses `@/*`), but inconsistent with the rest of `src/**/*.test.ts` — a quick grep shows existing suites tend to use `@/…` when crossing module boundaries. Minor.
- **No test for the `timeoutMs` override actually propagating from `AgentRunOptions` to the real adapter.** The integration test at line 74-90 only exercises the Promise.race shell, not that a hung `generateText` in `XAIAgent._run()` gets killed. Parity test suggested in thesis fix #6 is correctly identified.
- **`package.json` `test:live-readiness` references `src/live/factory.test.ts` (which exists, pre-existing file) — not flagged but it pins the script to a file the worktree does not own.** If `factory.test.ts` is deleted/renamed the audit script silently breaks. Another reason to drop the script entirely.

### Verdict reasoning
REWORK, not BLOCK. The timer leak is a genuine production defect (blocks clean shutdown; on a pipeline that runs 24/7 inside a single-user home trading setup this is observable), but fixable with a 10-line move. The thesis's six required fixes are all valid; add two more: (7) move the `vi.mock('@anthropic-ai/claude-agent-sdk', …)` call out of the test body in `src/agent/timeout.test.ts:77`; (8) once the per-provider wrappers are removed per fix #1-#2, re-home the XAIAgent integration test to mock `generateText` directly rather than the agent SDK. Once those land, merge.
