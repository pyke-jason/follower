# elegant-galileo-69a953

## Goal
Pre-live DB integrity audit: close two concrete atomicity races (reconcile-resolve, hasUpdate stamping), eliminate a reconciliation alert dedup race, tighten reconciliation cadence, add a composite trades index and two partial unique indexes on `reconciliation_alerts`, and fail fast at startup if DB migrations are out of date.

## Changes
- `src/local-api/routes/web-mutations.ts` — reconciliation resolve now collects the optional trade write as a deferred function and runs both writes inside one `runTx()` (atomic).
- `src/trades/trade-flags.ts` — `stampHasUpdate` wraps per-symbol SELECT + UPDATEs inside `runTx()` to close a read-modify-write race with `addTradeFlags`.
- `src/reconciliation/reconciler.ts` — `.onConflictDoNothing()` added to the alert insert as concurrency guard.
- `src/reconciliation/scheduler.ts` — default `intervalMs` reduced from 5 min to 1 min.
- `src/db/schema.ts` — composite index `idx_trades_channel_status` + two partial unique indexes on `reconciliation_alerts` enforcing the app-level dedup key.
- `src/db/startup-maintenance.ts` — new `validateMigrations()` throws if `drizzle_migrations` count < `_journal.json` entries. Skipped under `VITEST`.
- `drizzle/0001_talented_ender_wiggin.sql` + `0001_snapshot.json` + `_journal.json` — generated migration for the three indexes.
- `docs/lessons/2026-04-24-pre-live-db-integrity-audit.md` — rationale and follow-ups.

## Justification per change
- `web-mutations.ts` — JUSTIFIED. Two separate `db.update` calls; a crash between them left trade closed but alert unresolved, keeping DB_ONLY elevated and blocking opens. Local diff, no new abstraction.
- `trade-flags.ts` — JUSTIFIED. Read-modify-write on JSONB `metadata.flags`. Matches the `addTradeFlags` pattern already in the same file.
- `reconciler.ts` — JUSTIFIED. Correct partner to the new partial unique indexes.
- `scheduler.ts` — JUSTIFIED-LITE. One-line cadence change; 5x more cheap `getPositions()` calls, worthwhile given DB_ONLY-blocks-trading semantics.
- `schema.ts` (composite index) — JUSTIFIED. Hot-path query; existing single-column indexes insufficient.
- `schema.ts` (partial unique indexes) — JUSTIFIED. Split on `trade_id IS NULL` vs `IS NOT NULL` is necessary because Postgres treats NULL as distinct in unique indexes; the inline comment explains this.
- `startup-maintenance.ts` (`validateMigrations`) — JUSTIFIED. Loud fail-fast beats silent column-not-found errors mid-trade. VITEST bypass pragmatic; journal-read fallback (skip if unreadable) prevents bricking a bundled deployment.
- Drizzle migration — SUSPECT (mechanical collision only). Main's uncommitted working tree already has `0001_chemical_jetstream.sql` (`ALTER TABLE trades ADD COLUMN planned_exit_date`). Both claim slot 0001; `when` timestamps differ. Content is fine, filename/snapshot prevId must be regenerated.
- Lesson file — JUSTIFIED. Honest about unfixed follow-ups.

## Concerns
- **Migration slot collision**: `drizzle/0001_talented_ender_wiggin.sql` collides with main's `0001_chemical_jetstream.sql`. Must be regenerated to `0002` via `npm run db:generate` — NOT hand-edited (per `database-trades.md`, hand-editing the snapshot chain breaks future `db:generate`).
- **Unverified assertion in lesson**: the claim that DB_ONLY alerts block new live trades is load-bearing for the atomicity fix's justification. The fix stands on its own merits regardless, but the blocking behavior should be confirmed in `checkRiskLimits` / live runner gating at merge verification.

## Verdict
**MERGE** (after regenerating the migration as 0002). Every code change hits the rubric: production-critical correctness, no bloat, single-user-appropriate, no `if (isBacktest)` branches, real race-closers not theatre. The atomicity fixes are short and on-target; the schema additions are properly paired with `onConflictDoNothing()`; `validateMigrations` is a sensible fail-fast for going live. Only blocker is mechanical.

## Required fixes
1. `drizzle/0001_talented_ender_wiggin.sql` + `drizzle/meta/0001_snapshot.json` + `drizzle/meta/_journal.json` — after rebasing on main (which includes `0001_chemical_jetstream`), run `npm run db:generate` to emit the three index DDLs as `0002_<name>`. Do not rename files or hand-edit `prevId`.

## Reviewer verdict

**DO NOT MERGE** — two blocker bugs found during falsification.

### Blocker 1: `validateMigrations` queries the wrong table name (certain to fail on every startup)

`src/db/startup-maintenance.ts:26` runs `SELECT COUNT(*) FROM drizzle_migrations`. Verified against the running DB: the drizzle-orm node-postgres migrator creates `drizzle.__drizzle_migrations` (double underscore, in the `drizzle` schema). Empirically:

```
trade_follower=> SELECT COUNT(*) FROM drizzle_migrations;
ERROR:  relation "drizzle_migrations" does not exist
trade_follower=> SELECT COUNT(*) FROM drizzle.__drizzle_migrations;
 count
-------
     0
```

The catch branch matches `"does not exist"` and throws the "Database schema uninitialized — run `npm run db:migrate`" error. Net effect: every startup throws, dev + live. The feature is strictly net-negative as written. Fix: `SELECT COUNT(*) FROM drizzle.__drizzle_migrations`.

### Blocker 2: Bootstrap chicken-and-egg — `db:migrate` itself imports `db/client.ts`

`src/db/migrate.ts` does `import { db, pgPool } from './client.js'`, and `client.ts` has a top-level `await runStartupMaintenance(db)` which now calls `validateMigrations()`. On a fresh DB (no `__drizzle_migrations` table yet), `npm run db:migrate` throws at module load, before the migrator can run. Even after fixing Blocker 1, `validateMigrations` must be skipped (or made non-throwing on "table missing") when invoked from the migrator. Simplest fix: detect the missing table and return early rather than throw, OR gate `validateMigrations` on an env var that `migrate.ts` unsets, OR move the call out of `runStartupMaintenance` and into the runner entry points only.

### Confirmed concerns from thesis
- **Migration slot collision confirmed.** Main's uncommitted working tree has `drizzle/0001_chemical_jetstream.sql` (`ADD COLUMN planned_exit_date` + `idx_trades_planned_exit`). Both snapshots share `prevId: 2199339b…`. Regenerate as 0002 after rebase.
- **DB_ONLY blocks trading**: confirmed at `src/orders/risk-check.ts:159` — reason string set when `alertCount > 0`, so B1c atomicity justification stands.

### Additional issues (lower severity)
- **stampHasUpdate tx is not actually race-free under default isolation.** Postgres default is READ COMMITTED; wrapping SELECT-then-UPDATE in a tx does not prevent lost updates without `FOR UPDATE` row locking or SERIALIZABLE isolation. Two concurrent tx can both read old metadata, both merge, and the second write clobbers the first. The fix matches the existing `addTradeFlags` pattern — so it is consistent but not actually correct. For a single-user system this is low-impact in practice but the lesson note overclaims.
- **Orders of magnitude fine for single-user**: 1-min reconciliation cadence is fine. `onConflictDoNothing` pairing with partial unique indexes is correct (targets them correctly).

### Verdict
Fix Blockers 1 and 2 (neither is one-line — Blocker 2 requires rethinking where `validateMigrations` runs), regenerate the migration as 0002 after rebasing, then MERGE. As committed, the worktree bricks `db:migrate` and every subsequent startup; this cannot go live.
