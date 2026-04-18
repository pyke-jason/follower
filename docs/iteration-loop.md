# Backtest Iteration Loop

The process I follow autonomously to drive classification toward 100%. Reload this at the start of each session.

## Goal

Every message in the chat room should be classified correctly:
- `EXECUTE` with the right action, strategy, direction, legs, quantity
- `SKIP` with the right reason (hard skip, no-trade, risk-blocked, etc.)
- `MANUAL_REVIEW` only when the message is genuinely ambiguous to a human

Ground truth lives in `eval_labels` (human-verified rows). Assume the labels themselves may be wrong — audit them, and flip `humanVerified=false` / rewrite the label when I find a real mistake.

## One cycle (TDD-style)

1. **Pick up**. Look at the most recent `backtest_runs` row. If `FAILED` or `CANCELLED`, investigate `.logs/<id>.log`. If `COMPLETED`, skip to step 4.
2. **Root-cause the crash** (if any). Fix at the right layer — parser, orchestrator, executor, or broker/market-data. Pipeline code stays shared (no `if (isBacktest)`).
3. **Rerun**. Launch the same config (Sept 2025 full month, all traders, xai grok-4-1-fast-non-reasoning) via the local API `/web/backtests/spawn`. Wait for completion.
4. **Audit classification**. For the completed run:
   - Query `run_decisions` joined with `eval_labels` on `message_id`.
   - Bucket mismatches: `false_positive` (we traded, label says no), `false_negative` (we skipped, label says trade), `wrong_action`, `wrong_strategy`, `wrong_direction`, `manual_review_but_clear`.
   - Rank buckets by frequency × impact.
5. **Pick ONE failing case. Write a test that captures it.** The test lives next to the code being fixed. Red first.
6. **Fix the code** so the test goes green. Preference order for where to fix: deterministic parser → orchestrator routing → LLM prompt → eval label (only if the label is actually wrong). Smallest change that kills the bug.
7. **Rerun the backtest** and confirm the metric moved in the right direction — not just the test.
8. **Log the cycle**. Append a row to `scratchpad/iteration-log.md`: date, run id, failing case, test added, fix, before/after metric. Write a lesson in `docs/lessons/YYYY-MM-DD-slug.md` if the root cause was non-obvious.
9. **Loop.**

The outcome is 100% classification accuracy. Every other property of the code — file layout, test framework, abstractions — is negotiable. If the current test setup doesn't support a failing case, change the test setup. If a whole module is in the way, rewrite it.

## Hard rules

- **Fix root causes.** No try/catch bandaids that hide a real bug. Graceful skips are only acceptable when the skip is the correct behavior (e.g., symbol has no market data).
- **Trust eval labels provisionally.** If the classifier disagrees with a label, read the message. Sometimes the label is wrong — flip it and record in the audit.
- **Pipeline code is shared.** See `docs/rails.md`. No backtest-only branches in `src/pipeline/` or `src/orders/`.
- **Quality gates must pass** before launching a rerun: `npx tsc --noEmit && npm test && npm --prefix web run check`.
- **One cycle per commit.** Small, reviewable diffs. Message format: `fix(<area>): <what> — <run-id>`.
- **Kill bad runs early.** Don't wait for a broken backtest to finish. While a run is in flight, tail `.logs/<run-id>.log` and query `run_decisions` for the partial results. If any of the following are true, cancel the run (`POST /web/backtests/<id>/cancel`) and iterate instead of wasting compute:
  - The same error repeats across many messages (e.g. a specific symbol crashes the pricing path over and over).
  - Orchestrator output is regressing vs the previous run (accuracy on labeled messages is dropping, MANUAL_REVIEW rate is climbing, pipeline errors are cascading).
  - A trivial mistake you just made is firing thousands of times (typo in a new regex, wrong SQL condition, etc.).
  A long run is only worth finishing if the data it produces will actually be useful to audit. If it won't, stop it, fix the root cause, relaunch.

## Data sources

- `backtest_runs` — run metadata, status, error
- `run_decisions` — per-message decision: outcome, phase, skip category, reasoning, trade id
- `messages` — raw + parsed message content (symbols, action hint, direction hint, detected strategies)
- `eval_labels` — human-labeled ground truth (outer array = trades, inner = legs)
- `trades` / `trade_events` — executed trades and their lifecycle
- `.logs/<run-id>.log` — full stdout/stderr from `launch.ts`

## Launch config (stable across iterations)

```
startDate:   2025-09-01
endDate:     2025-09-07    # one trading week — iterate fast, widen once classifier stabilizes
traders:     all from tracked_traders (enabled)
fillModel:   orats
agent:       xai / grok-4-1-fast-reasoning
logLevel:    debug
```

Change the config only if the change is part of the fix being tested. Once classification accuracy stabilizes, widen the window back to full Sept 2025 for the final performance measurement.
