# 2026-04-20 — Production logging hardening

## Problem

Logs were ephemeral. Backend stdout lived only in the orchestrator terminal; close the window and it was gone. Sidecar (Java) wrote to stdout only. `uncaughtException` just `console.error`'d before exit and `unhandledRejection` wasn't handled at all. `.logs/` had 354 MB of unrotated backtest/classify run files from February onward. No structured (JSON) output meant no `jq`, no correlation.

## Decision

Pino-backed structured logger with multistream: pretty to terminal (preserving the existing `[level] [MM/DD HH:MM:SS.mmm] [tag] msg` format exactly), JSON-per-line to a daily-rotated file. Per-service rolling files keyed by `LOG_PROCESS_NAME` env var (`backend`, `api`, `backtest`, `classify`). Sidecar gets a `RollingFileAppender` in `logback.xml` using `LOG_DIR` passed from `dev-up`. Orchestrator writes an ANSI-stripped terminal replay to `.logs/terminal-YYYY-MM-DD.log` — literal scrollback for "what did I see at 3pm." Retention janitor at `dev-up` startup prunes `.logs/*` older than 14 days.

Why pino: verified as the 2026 standard-bearer (fastest, best-maintained, structured-first). LogTape exists but is newer and has smaller ecosystem. `createLogger(tag)` API shape preserved so all 321 existing call sites keep working — the wrapper handles printf-style `logger.info('x:', obj, err)` by extracting `Error` instances into `{ err }` and merging plain-object first args as pino bindings.

## Key files

- `src/lib/logger.ts` — pino root with multistream [pretty stdout, rolling JSON file]; `createLogger`, `setLogLevel`, `flushLogs`
- `src/lib/log-rotation.ts` — `createRollingFileStream({ dir, prefix })` with UTC date rollover
- `src/lib/log-safety.ts` — `installProcessErrorHandlers({ onFatal, exitOnUncaught })` wires `uncaughtException` + `unhandledRejection` to the logger
- `src/index.ts` — calls `installProcessErrorHandlers` with `releaseLock` cleanup; removed the old console-based handler
- `src/local-api/server.ts` — calls `installProcessErrorHandlers()` at top
- `scripts/dev-up.ts` — terminal replay stream, `LOG_PROCESS_NAME` per child (api/backend), `LOG_DIR` for sidecar, `pruneOldLogs(14)` at startup
- `src/local-api/routes/backtests.ts`, `classify-spawn.ts` — subprocess spawn sets `LOG_PROCESS_NAME=backtest|classify`
- `sidecar/src/main/resources/logback.xml` — `RollingFileAppender` → `${LOG_DIR}/sidecar-YYYY-MM-DD.i.log`, 50 MB/file, 14-day history, 500 MB total cap

## Watch out

- **Cross-process appends** to the same `<proc>-YYYY-MM-DD.log` rely on POSIX `O_APPEND` atomicity. Lines above 4 KB could interleave on Linux/macOS. Pino lines are typically well under that; Error stacks stay below it too.
- **Date rollover is UTC.** Switching files happens when `new Date().toISOString().slice(0,10)` changes, not at ET midnight. Log-aggregation across rolls still works because each line has its own millisecond timestamp.
- **`.logs/` now holds two kinds of files:** per-service pino JSON (`backend-*.log`, `api-*.log`, `backtest-*.log`, `classify-*.log`, `orchestrator-*.log` if ever), sidecar logback files (`sidecar-*.log`), the terminal replay (`terminal-*.log`), and the legacy per-run `{runId}.log` files written by backtest/classify subprocess `stdio` redirect (still used by the dashboard `GET /logs/:id`). All share the 14-day retention.
- **Don't delete `{runId}.log` files while a run is in PENDING/RUNNING status.** The retention janitor only checks `mtime`, not DB status. In practice 14 days is far longer than any run, so not an issue — but if someone lowers `LOG_RETENTION_DAYS`, mind this.
- **`installProcessErrorHandlers` exits the process by default.** For EADDRINUSE in local-api this is correct (the process is unusable). If you ever wire this into a context where you want to keep going, pass `{ exitOnUncaught: false }`.
- **The pino logger initializes at module import time** (side effect: `mkdirSync` + `createWriteStream`). Importing `logger.ts` anywhere — including in vitest — creates the day's `app-YYYY-MM-DD.log` file. Empty files are harmless; rotation/retention handle them.
