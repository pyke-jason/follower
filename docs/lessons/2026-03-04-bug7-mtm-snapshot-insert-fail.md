# Bug 7: backtest_mtm_snapshots insert failure

Date: 2026-03-04

## Problem

Backtests failed on day-boundary MTM snapshot insert:
```
Failed query: insert into "backtest_mtm_snapshots" ("id", "channel_id", "date", "unrealized_pnl", "created_at") values (?, ?, ?, ?, ?)
```

Root cause: migration 0023 (channel scoping) added `channel_id` and the code stopped providing `backtest_run_id`, but the original table (migration 0013) had `backtest_run_id TEXT NOT NULL`. SQLite can't `ALTER COLUMN` or `DROP COLUMN`, so the NOT NULL constraint survived. Inserts without `backtest_run_id` failed.

## Decision

1. Created migration 0025 (via `drizzle-kit generate --custom`) to rebuild the table: create new → copy data → drop old → rename.
2. Fixed `db:generate` which had been broken since migration 0014: `schema.ts` imported runtime values from `../lib/enums.js` which drizzle-kit's CJS bundler couldn't resolve. Inlined the Zod enum values.
3. Regenerated snapshot chain: 0025_snapshot.json now reflects current schema.ts. `db:generate` works for future schema changes.

## Key Files

- `drizzle/0025_rebuild_mtm_drop_backtest_run_id.sql` — table rebuild migration
- `drizzle/meta/0025_snapshot.json` — fresh snapshot matching current schema.ts
- `src/db/schema.ts` — inlined LegTypeSchema/LegActionSchema to fix drizzle-kit loading
- `drizzle.config.ts` — `import.meta.dirname ?? '.'` fallback for CJS mode
- `.claude/rules/database-trades.md` — updated migration rules

## Watch Out

- **Snapshot chain**: Migrations 0014-0024 still have no snapshots. 0025 bridges the gap. If you ever need to regenerate: create temp dir, run `db:generate` from clean state, copy snapshot.
- **SQLite constraint persistence**: When replacing columns, always check old NOT NULL / FK constraints with `PRAGMA table_info(...)`. They don't go away with `ALTER TABLE ADD COLUMN`.
- **schema.ts imports**: Keep runtime imports to npm packages only. Type imports are fine (erased at compile time).
