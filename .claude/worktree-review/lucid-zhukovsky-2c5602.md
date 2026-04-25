# lucid-zhukovsky-2c5602 — disk-log-hardening

## Goal

Three pre-live disk-safety fixes: (1) gitignore profiling artifacts that have already been committed once (54 MB `profiling-data.json` in `1817466`), (2) add a 100 MB intra-day size cap to the daily log rotation, (3) add a startup free-disk-space guard that refuses to start if less than `MIN_FREE_DISK_GB` (default 5) is available.

## Changes

- `.gitignore`: added `profiling-data.json`, `*.cpuprofile`, `*.heapprofile`, `*.heapsnapshot`, `isolate-*.log` (5 lines).
- `src/lib/log-rotation.ts`: added `MAX_FILE_BYTES = 100 * 1024 * 1024`, read existing size at open via `statSync`, track `bytesWritten`, and roll on `bytesWritten + chunk > 100MB` using a `YYYY-MM-DDTHH-MM-SS` timestamp key to avoid colliding with the same-day file.
- `src/lib/disk-check.ts` (new, 19 lines): uses `fs/promises.statfs(PROJECT_ROOT)`, computes `bavail * bsize`, throws if below threshold.
- `src/index.ts`: `await checkDiskSpace()` as first statement in `main()`, before `acquireLock()`.
- `docs/lessons/2026-04-24-disk-log-hardening.md`: author rationale — lock ordering is intentional (disk-full machine should not hold the lock).

## Justification per change

1. **gitignore profiling artifacts.** Real: there is a verifiable historic incident (`git log -- profiling-data.json` shows `1817466` then `296fbfe` removal). Costs nothing, prevents a 50+ MB recommit after any future profiling session. Good pure-hygiene.

2. **Log-rotation 100 MB cap.** Real concern for a long-running single-user backend, but **borderline bloat vs OS-tool reinvention**. macOS has `newsyslog`; Linux has `logrotate`. That said, this writer is in-process and the cap is enforced synchronously at write time without requiring an external config — pragmatically the simplest thing that works for a solo operator who isn't going to configure `newsyslog.d`. The implementation is correct: existing-size read at open handles mid-day restart, `bytesWritten` tracked in closure, timestamp key avoids collision, `old.end()` flushes. Small-scope, ~40 lines, not over-engineered. Acceptable.

3. **Startup disk-space guard.** Real: Postgres WAL + Playwright browser cache + rolling logs can fill a disk, and writes silently corrupt things. Using `statfs` over `bavail*bsize` is the right primitive (counts only user-available blocks, not reserved). The 5 GB default is generous but reasonable for Databento caches and log bursts. Env-overridable for CI.

## Concerns

**(1) Startup-only check is theatre for runtime disk-full.** The rubric explicitly calls out "Detection without action (alert + halt-trading) is theatre." `checkDiskSpace()` runs exactly once in `main()` and never again. A disk that has 10 GB at 09:00 and fills to 0 at 14:00 — during market hours — will not be detected by this guard. The author ships a startup-only gate and calls it done. For go-live safety, disk monitoring should be periodic (e.g., piggyback on the existing `startHealthcheck` dead-man's-switch) and call `sendSystemAlert({ severity: 'critical' })` rather than `throw`. The infrastructure for this already exists — `sendSystemAlert` is imported three lines above the `checkDiskSpace` import in the same file. This is a one-line miss that makes the feature meaningfully less real.

**(2) Throw-not-alert at startup.** Even at startup, `throw new Error(...)` propagates to `main().catch(err => { console.error(...); process.exit(1); })`. No Pushover, no Discord. For a solo operator who has restarted the backend on a phone over SSH, the error is on stderr in the terminal — acceptable if they're watching, silent if they're not. Should call `sendSystemAlert` before throwing (or instead of it for a soft-warn mode).

**(3) 100 MB log cap without total-size budget.** The cap is per-file, not per-directory. `pruneOldLogs()` in `scripts/dev-up.ts` deletes files older than `LOG_RETENTION_DAYS`, but only runs on orchestrator startup (author acknowledges this in "Watch Out"). Between restarts, a chatty process could theoretically accumulate N × 100 MB files within a single retention window. For a single-user backend, probably fine; worth noting as a known gap.

**(4) `.replace('T', 'T')` in `tsKey`.** Harmless dead code — the explicit no-op survives from a refactor and should be dropped. Picky but trivial.

**(5) Non-concern:** no pipeline `isBacktest` branches, no multi-tenant code, no cross-module reach. Changes are narrowly scoped to startup + log writer.

## Verdict: MERGE (with a follow-up)

Merge as-is. The three changes are small, self-contained, uncontroversial, and address real pre-live concerns. The gitignore block prevents a documented historic 54 MB regression. The log-rotation cap is a reasonable in-process reinvention that spares the operator from configuring `newsyslog`. The startup disk check is better than nothing and the `throw`-before-lock ordering is defended in the lesson file.

The theatre risk is real but bounded: startup-only detection catches the common case (operator spins up on a machine that's already dangerously full) and misses the mid-session fill-up case. That gap is a follow-up, not a blocker — the alternative is rejecting a narrow, correct, low-risk patch because it isn't the complete solution. Ship it, file the follow-up.

## Required fixes (before merge)

None blocking.

## Recommended follow-ups (after merge)

1. Wire `checkDiskSpace` into `startHealthcheck`'s periodic tick (runtime detection).
2. Replace `throw` with `sendSystemAlert({ severity: 'critical', ... })` + `process.exit(1)` so low-disk startups page the operator.
3. Drop the `.replace('T', 'T')` no-op in `tsKey`.
4. Consider a directory-size budget (e.g., fail-closed alert if `.logs/` exceeds 2 GB) since per-file caps don't bound aggregate growth between restarts.

## Reviewer verdict

Tried to falsify; thesis survives. Verified claims:

- **Historic 54 MB regression is real.** `git log -- profiling-data.json` shows exactly the two SHAs the thesis cites (`1817466` add, `296fbfe` remove). Five-line gitignore block is free insurance, not bloat.
- **Disk-check action = `throw` only.** `src/lib/disk-check.ts:12` throws; caller is `main().catch()` in `src/index.ts` which does `console.error` + `process.exit(1)`. No `sendSystemAlert` call despite the import being on the adjacent line (`src/index.ts:16-17`). Thesis concerns (1) and (2) are accurate — this is detection-without-action for any mid-session disk fill, and silent-on-phone for headless startup failures.
- **Startup-only is the full story.** `startHealthcheck` (`src/lib/healthcheck.ts:36`) already runs a 60 s `setInterval` — plumbing `checkDiskSpace()` into its `ping()` is genuinely a ~3 line change the author skipped. The theatre critique lands: for go-live this is a one-shot gate, not a monitor.
- **Log-rotation reinvents `logrotate`/`newsyslog` — but pragmatically.** The in-process writer already existed; this change just bounds it. Avoiding an external config file for a solo-operator system is defensible. `statSync` at open correctly recovers mid-day restart state, `tsKey` collision-avoidance is sound, `old.end()` flushes. ~40 lines, no new deps. Not overengineered; not the OS-tool reinvention the rubric warns about.
- **`.replace('T', 'T')` no-op confirmed** at `log-rotation.ts:29`. Harmless; trivial.
- **`.gitignore` diff matches thesis exactly** — five patterns added under a "profiling artifacts" comment, nothing removed, no scope creep.
- **No pipeline branches, no `isBacktest`, no cross-module reach.** Clean.

**Verdict: AGREE — MERGE with follow-ups.** Thesis is calibrated. The "merge-with-follow-up" call is correct: the patch is narrow, correct, and addresses documented real risks. Rejecting it because it isn't the complete monitoring solution would be letting perfect block good. The startup-only gap and missing `sendSystemAlert` are real but the thesis already flags both as non-blocking follow-ups. Author's lesson file honestly discloses the `pruneOldLogs()` gap and lock-ordering rationale.

One minor strengthening: follow-up (1) [wire into `startHealthcheck`] should be promoted above (2) [alert-on-startup] in priority — periodic monitoring subsumes the startup case, whereas adding `sendSystemAlert` to a once-per-boot throw only helps the narrow "operator not at terminal during cold start" case. Ship it.
