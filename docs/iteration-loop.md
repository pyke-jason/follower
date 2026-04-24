# Backtest Iteration Loop

The process I follow autonomously to drive classification toward 100%. Reload this at the start of each session.

## Goal

Every message in the chat room should be classified correctly. **Classification ≠ execution.** The classifier's job is to interpret what the trader's message means (action, symbol, strategy, direction, strikes, etc.). Execution decisions (risk-block, position match, Databento chain gaps, blacklisted symbols) are DOWNSTREAM of classification and must not be confused with classifier errors.

Ground truth lives in `eval_labels` (human-verified rows). Labels themselves may be wrong — audit them, flip `humanVerified=true` with a corrected label when needed.

## User directives (load-bearing)

These came from the user during iteration. Treat them as binding.

- **ZERO budget. Iterate continuously, all night if needed.** No stopping until classification is 100%. Don't sleep unnecessarily — schedule short wakeups, kick off parallel work while waiting.
- **Default to Claude Sonnet 4.6.** Use `anthropic / claude-sonnet-4-6` for backtest and listener runs unless the user specifies a different model.
- **Kill bad runs early.** Don't let a broken backtest chew hours of compute. Monitor for systematic misclassification patterns (`scratchpad/monitor-backtest.ts`) and cancel immediately — fix root cause, relaunch.
- **Parallelize aggressively.** Use sub-agents (general-purpose) for label audits in parallel batches. Launch multiple backtests on different date windows when the DB contention allows.
- **Classification is decoupled from execution.** When measuring accuracy, compare parser-orchestrator output to labels — not execution outcome. Risk-blocked / unfollowed-exit / blacklist / no-chain / calendar-spread are policy/execution decisions, not classification errors.
- **Every signal field matches, not just isTrade.** True 100% means action, symbol, strategy, direction, strikes, expiry, statedPrice all match. `scratchpad/audit-deep.ts` compares deep fields.
- **Write tests for failing cases.** Don't index on existing test framework — overhaul if needed. Red test → fix → green.
- **Fix root causes.** No try/catch band-aids, no `if (isBacktest)` branches, no stale comments. One-line WHY-only comments when needed at all — never narrate, never describe what the code does.
- **Update this file when I give new advice.** Any load-bearing directive goes here so future sessions inherit it.
- **Git: user handles all commits and pushes.** I don't commit, don't push, don't touch git history.

## One cycle (TDD-style)

1. **Pick up.** Look at the most recent `backtest_runs` row. If `FAILED` or `CANCELLED`, investigate `.logs/<id>.log`. If `COMPLETED`, skip to step 4.
2. **Root-cause the crash.** Fix at the right layer — parser, orchestrator, executor, or broker/market-data. Shared pipeline code (`src/pipeline/`, `src/orders/`) must not branch on backtest vs live.
3. **Rerun** via the local API `/web/backtests/start` with the config below. Monitor in background (`scratchpad/monitor-backtest.ts`).
4. **Audit classification.** `scratchpad/audit-classification.ts <runId>` — uses PARSED event for classifier decision (hardSkip / action != null) and SETTLED only for LLM-routed action=null messages. Bucket mismatches by field.
5. **Pick ONE failing case.** Write a test that captures it if one doesn't exist. Red first.
6. **Fix.** Preference: deterministic parser → orchestrator routing → LLM prompt → label (only if the label is actually wrong).
7. **Rerun + re-audit.** Confirm the metric moved in the right direction, not just the test.
8. **Log the cycle** in `scratchpad/iteration-log.md`.
9. **Loop.**

## Parallelism playbook

- **Sub-agents for label audits.** Scope each to a specific date slice + specific error pattern. Conservative > aggressive — LOW confidence if unsure. Never auto-apply LOW flips. `scratchpad/apply-audit-results.ts` applies HIGH flips idempotently.
- **Multiple runs vs one run.** Running `bt:A` and `bt:B` concurrently works (different `channelId`). But SimBroker/Databento fetches will contend — OK for short smoke runs, not ideal for two full-month runs.
- **Cache warming.** Each completed backtest populates `message_intents` at the current `INTENT_VERSION`. Future runs at the same version skip LLM calls for those messages. Bumping INTENT_VERSION invalidates everything — do it only when parser/prompt/schema changes meaningfully affect outputs.
- **Monitor + Bash `run_in_background`.** Use Monitor for long-running backtests (each stdout line is a notification). Use Bash `run_in_background: true` for one-shot "wait until done".
- **Selective cache invalidation.** When you identify a specific mis-handled message, delete just that row from `message_intents` and relaunch. No need to re-LLM the whole month.

## Hard rules (enforced)

- **Fix root causes.** No try/catch band-aids. Graceful skips are only acceptable when the skip is correct behavior (e.g., symbol has no market data → `QuoteUnavailableError`).
- **Pipeline code is shared.** See `docs/rails.md`. No `if (isBacktest)` branches in `src/pipeline/` or `src/orders/`.
- **Quality gates before relaunch:** `npx tsc --noEmit && npm test`.
- **Kill bad runs early on systematic misclassification.** Cancel (`POST /web/backtests/<id>/cancel`) when:
  - Same `reasoning` string appears ≥10 times across `SKIP` or `pipeline_failure` outcomes.
  - One skipped symbol or error category makes up >20% of all outcomes.
  - Accuracy drops >2 pp below previous baseline.
  - A fix you just shipped is clearly not firing (check INTENT_VERSION, cache invalidation).

## Data sources

- `backtest_runs` — run metadata, status, error
- `run_decisions` — per-message decision: outcome, phase, skip category, reasoning, snapshot (parse/resolved/signal JSON), trade id
- `messages` — raw + parsed message content
- `eval_labels` — human-labeled ground truth (`Signal[][]` per `EvalLabelData`)
- `message_intents` — LLM cache (keyed on message_id + model + version)
- `.logs/<run-id>.log` — stdout/stderr from `launch.ts`

## Launch config

```
startDate:   2025-09-01
endDate:     2025-09-30    # full month once classifier is stable; narrower for fast iteration
traders:     all from tracked_traders (enabled)
fillModel:   orats
agent:       anthropic / claude-sonnet-4-6
logLevel:    debug
```

Change the config only if the change is part of the fix being tested.

## Tooling cheat sheet

| Script | Purpose |
|---|---|
| `scratchpad/audit-classification.ts <runId>` | Primary accuracy audit (classifier-focused). |
| `scratchpad/audit-deep.ts <runId>` | Per-field deep comparison (action, symbol, strategy, strikes, expiry). |
| `scratchpad/monitor-backtest.ts <runId>` | Live early-stop on systematic patterns. |
| `scratchpad/apply-audit-results.ts <results.json>` | Idempotently apply HIGH-confidence flips from sub-agent audits. |
| `npx tsx scripts/eval-orchestrator.ts --tag skip` | Orchestrator skip-eval regression tests. |
