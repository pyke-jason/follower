# Worktree audit: hungry-agnesi-f0b6e5 — DB backup & restore

## Goal
Add nightly Postgres backups for the trade-follower DB ahead of go-live, plus a restore path and a launchd installer to schedule it on macOS.

## Changes
- `scripts/db-backup.sh` (new, 59 lines): `pg_dump --format=custom --compress=6` to `~/backups/trade-follower-3/YYYY-MM-DD.pgdump`, with two sanity checks (size > 10 KB, `pg_restore --list` TOC parses) and prune of files older than 14 days.
- `scripts/db-restore.sh` (new, 109 lines): stops the backend via `data/backend.lock`, terminates other connections to the DB, drops/recreates it, restores from named snapshot. Interactive `yes` confirm. Tells user to run `db:migrate` after.
- `scripts/install-backup-launchd.sh` (new, 92 lines): installs/uninstalls a LaunchAgent plist (`com.tradefollower.dbbackup`) running `db-backup.sh` at 02:00 nightly, with `--uninstall` flag. Resolves `pg_dump` path explicitly so launchd's minimal PATH works.
- `package.json`: adds `db:backup` and `db:restore` npm scripts (2 lines).

No source code touched, no schema migrations, no dependencies.

## Justification per change
- db-backup.sh: Uses `pg_dump --format=custom`, the standard tool, no wheel reinvention. Custom format is the right call (compressed, supports parallel `pg_restore`, has a TOC). Two sanity checks are minimal and correct: size floor catches silently-aborted dumps, `pg_restore --list` catches corruption without restoring. `stat -f%z 2>/dev/null || stat -c%s` correctly handles both BSD (macOS) and GNU stat. 14-day retention is reasonable for a single-user local DB.
- db-restore.sh: Correctly integrates with the project's existing `data/backend.lock` convention (verified: used by `src/lib/paths.ts:12` and `scripts/dev-up.ts:461`). SIGTERM-with-10s-grace-then-SIGKILL is appropriate. `pg_terminate_backend` before `DROP DATABASE` is the standard incantation; without it `DROP` fails on any open session. `--no-privileges --no-owner` is correct for single-user local Postgres. Interactive confirmation gate stops accidental destruction.
- install-backup-launchd.sh: macOS-only via launchd matches the project's deployment (CLAUDE.md notes macOS Keychain as primary secret store). Explicit `pg_dump` path lookup with `/opt/homebrew/bin/pg_dump` fallback handles launchd's minimal-PATH gotcha. Supports clean `--uninstall`. Logs to `data/logs/db-backup.log`.
- package.json scripts: Single-line wrappers, zero abstraction overhead.

## Concerns
1. Restore was almost certainly never run end-to-end. No restore test or dry-run mode, and `db-restore.sh` is destructive. Rubric flags untested-backup as theatre. Mitigation: vanilla pg_dump/pg_restore round-trip on a single local DB has small failure surface; user can verify manually in 5 min.
2. `pnpm` references in restore script docs (lines 11, 34, 108, 109): `pnpm db:restore`, `pnpm db:backup`, `pnpm db:migrate`, `pnpm run up`. Project is npm (`package-lock.json` present, no `pnpm-lock.yaml`). Cosmetic but wrong instructions printed to user.
3. No off-machine copy. Backups live in `~/backups/trade-follower-3/` on the same disk as Postgres. Disk failure equals total loss. Real gap for go-live, but adding it later is fine.
4. `RunAtLoad=false` plus laptop sleep at 02:00: launchd runs a missed `StartCalendarInterval` job on wake (one catch-up). Acceptable; 14-day retention absorbs short gaps.
5. Hardcoded default DB URL `postgres://jason@127.0.0.1:5432/trade_follower`. Single-user system, env override exists. Appropriate, not bloat.
6. Lessons file missing. CLAUDE.md mandates `docs/lessons/YYYY-MM-DD-slug.md` after every session; none authored. Minor process violation.
7. No shell-script smells. `(( PRUNED++ )) || true` correctly handles post-increment-from-zero exit-code trap under `set -e`. Heredocs quoted correctly. No exponential backoff, retry loops, or over-engineered logging. Shell-craft is tight.

## Verdict: MERGE (with one trivial fix)
Best kind of pre-go-live worktree: small, standard, correct, uses the right tools (`pg_dump --format=custom`, `pg_restore --list`, launchd, the project's existing `data/backend.lock` convention). Correctly resists shell-script bloat. Validation checks are the minimum needed to catch real failure modes (silent abort, corrupt dump). macOS scoping is appropriate given the project's macOS-first stance (Keychain). The destructive restore script gates on interactive confirmation and integrates correctly with the backend lifecycle. Going live without backups is reckless; this fixes that with about 260 lines of well-scoped shell. The `pnpm` references are a cosmetic fix; the untested restore is a real concern but the round-trip path is well-trodden Postgres territory. Off-machine copy can be added later. None of this justifies blocking a backup-on-day-zero merge.

## Required fixes
1. Replace `pnpm` with `npm run` in `scripts/db-restore.sh`:
   - Line 11: `pnpm db:restore -- <YYYY-MM-DD>` to `npm run db:restore -- <YYYY-MM-DD>`
   - Line 34: `pnpm db:backup` to `npm run db:backup`
   - Line 108: `pnpm db:migrate` to `npm run db:migrate`
   - Line 109: `pnpm run up` to `npm run up`

## Recommended (non-blocking)
- Author `docs/lessons/2026-04-24-db-backup-restore.md` per CLAUDE.md's lesson mandate.
- Manually verify a backup-then-restore round-trip into a scratch DB once before relying on the schedule.
- Follow-up worktree to add off-machine backup mirroring (rsync to iCloud Drive, S3) — the local-disk-only failure mode is the largest remaining gap.

## Reviewer verdict: REQUEST CHANGES — launchd install is broken on this machine

Thesis is largely right about shape and scoping, but falsifies on one load-bearing claim and misses the most important mitigation.

**Falsified: "Explicit `pg_dump` path lookup ... handles launchd's minimal-PATH gotcha."** `install-backup-launchd.sh:30` computes `PG_DUMP_PATH` but **never uses it** in the generated plist. The plist only sets `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` and execs `db-backup.sh`, which calls bare `pg_dump`. On this machine pg_dump lives at `/opt/homebrew/opt/postgresql@16/bin/pg_dump` (keg-only) and `/opt/homebrew/Cellar/postgresql@16/16.13/bin/pg_dump`; **neither path is in the plist's PATH**, and `/opt/homebrew/bin/pg_dump` does not exist. The scheduled job will fail nightly with "pg_dump: command not found". Confirmed by direct filesystem check: `/opt/homebrew/bin/pg_dump` missing, pg_dump only under `Cellar/postgresql@16/`. Fix: either inject `PG_DUMP_PATH` into the plist PATH, or pass it to db-backup.sh via an env var and reference it there.

**Untested in real runtime.** `~/Library/LaunchAgents/com.tradefollower.dbbackup.plist` does not exist; `launchctl list | grep tradefollower` is empty. The backup file at `~/backups/trade-follower-3/2026-04-24.pgdump` came from a manual shell invocation (which has the user's PATH), not launchd. The entire launchd path — the whole point of this worktree — is unverified. Thesis's acceptance of "untested restore, small failure surface" misdirects; the bigger unverified path is the scheduled backup itself, and it is broken.

**Confirmed correct:**
- LaunchAgents (not LaunchDaemons) is the right choice — user-level job, HOME-scoped backup dir, `launchctl bootstrap gui/$(id -u)` is current (post-10.10) syntax with a `launchctl load` fallback.
- `pg_dump --format=custom --compress=6`, `pg_restore --list` sanity check, size floor, BSD/GNU `stat` fallback, 14-day retention, `pg_terminate_backend` before `DROP` — all textbook.
- Integration with `data/backend.lock` matches `src/lib/paths.ts:12` and `scripts/dev-up.ts:461`.
- `pnpm` references in `db-restore.sh` (lines 12, 33, 108, 109) are real: root is npm (`package-lock.json`, no `pnpm-lock.yaml`). Cosmetic as thesis says.
- No off-machine copy. Real gap, thesis acknowledges.
- No lessons file in `docs/lessons/` (verified, last is `2026-04-24-backtest-equity-live-mtm.md`).

**Minor:** `DB_NAME="${DB_URL##*/}"` in restore breaks on query params (`?sslmode=require`); fine for the hardcoded default but fragile.

**Verdict change:** Thesis says MERGE with one trivial fix. The launchd `PG_DUMP_PATH`-dropped-on-the-floor bug is not trivial — it silently disables the scheduled backup. Either wire `PG_DUMP_PATH` into the plist or add `/opt/homebrew/opt/postgresql@16/bin` to the plist PATH, then kickstart once and confirm `data/logs/db-backup.log` shows success. After that, merge.

## Reviewer verdict

**REWORK.** Independent re-audit confirms the prior reviewer's findings; the thesis's "MERGE with one trivial fix" understates the launchd defect.

**Falsification confirmed (load-bearing bug).** `install-backup-launchd.sh:30` resolves `PG_DUMP_PATH` and drops it on the floor — the variable is never interpolated into the plist. Direct filesystem check on this machine: `/opt/homebrew/bin/pg_dump` does not exist; pg_dump lives only at `/opt/homebrew/opt/postgresql@16/bin/pg_dump` (keg-only `postgresql@16`), which is **not** in the plist's hardcoded PATH. The scheduled job will fail nightly with "pg_dump: command not found". The thesis's own justification for the change ("Explicit `pg_dump` path lookup ... handles launchd's minimal-PATH gotcha") is the bit that's broken.

**Untested in real runtime confirmed.** `~/Library/LaunchAgents/com.tradefollower.dbbackup.plist` absent, `launchctl list | grep tradefollower` empty, `data/logs/` doesn't exist in the worktree. The `2026-04-24.pgdump` in `~/backups/trade-follower-3/` came from a manual invocation (user PATH), not launchd. The whole point of the worktree — scheduled backup — has never run.

**Agreements with thesis and prior reviewer:**
- Tooling/flags textbook: `pg_dump --format=custom --compress=6`, `pg_restore --list` integrity check, 10 KB size floor, BSD/GNU `stat` fallback, 14-day retention, `pg_terminate_backend` before `DROP`, `--no-privileges --no-owner`, interactive `yes` gate, SIGTERM-then-SIGKILL with grace.
- LaunchAgents (not LaunchDaemons) is correct: user-level job, HOME-scoped backup dir. `launchctl bootstrap gui/$(id -u)` with `launchctl load` fallback is current syntax.
- Plist paths are absolute (ROOT-derived). WorkingDirectory, log paths, ProgramArguments all correct.
- `data/backend.lock` integration matches `src/lib/paths.ts:12` and `scripts/dev-up.ts:461`.
- `pnpm` references in `db-restore.sh` (lines 12, 33, 108, 109) are wrong — root is npm (`package-lock.json`, no `pnpm-lock.yaml`); `db:restore`/`db:migrate`/`up` are root scripts. (Note: root `package.json` does invoke `pnpm dev` for the *web* sub-package, so `pnpm` isn't foreign to the repo, but these specific calls are wrong.)
- No off-machine copy. Disk failure = total loss. Real go-live gap; acceptable to defer.
- Lessons file missing (`docs/lessons/` ends at `2026-04-25-ingestion-subscription-recovery.md`; nothing for backup/restore).

**Disagreements:**
- Thesis labels the launchd PATH defect as not-discussed and the `pnpm` strings as the only required fix. The PATH defect is a hard bug that nullifies the worktree's primary deliverable.

**Missed by thesis:**
- `DB_NAME="${DB_URL##*/}"` breaks on `?sslmode=...` query params. Fine for the hardcoded default; fragile if env override is ever a real URL with params.
- No `pg_restore` path resolution either — same launchd PATH issue applies to the restore script if ever scripted, but restore is interactive so lower risk.

**Required before merge:**
1. Either inject `PG_DUMP_PATH` into plist PATH (e.g. prepend `$(dirname "$PG_DUMP_PATH"):`) or pass it as an env var consumed by `db-backup.sh`. Then `launchctl kickstart -k gui/$(id -u)/com.tradefollower.dbbackup` and confirm `data/logs/db-backup.log` shows a successful run.
2. Replace four `pnpm` strings in `db-restore.sh` with `npm run`.
3. Author `docs/lessons/2026-04-24-db-backup-restore.md` per CLAUDE.md.

After (1) and (2), this is a clean small PR worth merging.
