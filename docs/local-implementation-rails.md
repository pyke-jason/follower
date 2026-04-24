# Local Implementation Rails

This app is optimized for a single operator running it on one Mac. These rails are about local correctness and operability, not internet-facing security.

## Scope

- Run the backend, local API, browser ingestion, and dashboard on the same machine.
- Bind services to localhost unless there is a deliberate reason not to.
- Treat local Postgres as the source of truth for app state and tick-cache state.

## Runtime Rails

- Use one pinned Node major for the whole repo.
- Keep `web` and backend contracts type-safe. A passing bundle is not enough if the shared TypeScript surface no longer typechecks.

## Database Rails

- Postgres schema and migrations must be applied before running backend, local API, backtests, or classify jobs.
- Startup should repair lightweight integrity drift from older local runs:
  - clear orphan `taskId` references on `trades`
  - clear orphan `taskId` references on `run_decisions`
  - delete orphan `trade_events`
- Backtest deletion must remove child rows in dependency order:
  - `run_decisions`
  - `trade_events`
  - `trades`
  - `tasks`
  - `backtest_mtm_snapshots`
  - `backtest_runs`

## Process-Control Rails

- Backtest cancellation should be keyed by `runId`, not by caller-supplied PID.
- Only use a stored PID that belongs to the requested run.
- Any value that becomes a filename, especially `runId`, must be validated first.

## Operational Rails

- Treat `.logs/` and local Postgres databases as bounded local state, not infinite sinks.
- Prefer explicit cleanup paths for completed backtests and stale logs.
- Use these checks before trusting a change:
  - `npx tsc --noEmit`
  - `npm test`
  - `npm --prefix web run check`

## Non-Goals

- No auth or multi-user access control is assumed for the localhost-only setup.
- CORS hardening is secondary unless the app is exposed beyond the local machine.
