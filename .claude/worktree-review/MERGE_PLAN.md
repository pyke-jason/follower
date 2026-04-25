# Merge plan

Generated 2026-04-25 from 30 thesis + 30 independent reviewer verdicts.
Each thesis lives at `.claude/worktree-review/<worktree>.md` with both phases inline.

## Final disposition

| Worktree | Topic | Thesis | Reviewer | Final |
|---|---|---|---|---|
| awesome-liskov-9142be | order-manager: cancel/fill race + PENDING + per-runtime sets | MERGE | APPROVE | **MERGE** |
| competent-darwin-146b66 | IBKR symbology (BRK.B, mini-options, getPositions) | MERGE | APPROVE | **MERGE** |
| elegant-margulis-bf2ff8 | Dependency CVE patches (drizzle-orm, hono, vite, undici) | MERGE | MERGE | **MERGE** |
| festive-northcutt-b58a74 | Dashboard alerts panel + LIVE/PAPER badge | MERGE | MERGE | **MERGE** |
| lucid-zhukovsky-2c5602 | Disk-log hardening (gitignore, rotation cap, startup check) | MERGE | MERGE | **MERGE** |
| relaxed-bell-7b40c5 | Memory-leak audit (process metrics, pgPool shutdown) | MERGE | MERGE | **MERGE** |
| sharp-bhaskara-156016 | LLM security audit (timeout factored, sanitization) | MERGE | APPROVE | **MERGE** |
| wizardly-swirles-a68ff7 | Sidecar accountId ready-gate + IBKR_GATEWAY_PORT | MERGE | APPROVE | **MERGE** |
| wonderful-hodgkin-592a54 | Position sizing tests + cushion gate | MERGE | APPROVE | **MERGE** |
| busy-payne-f980b2 | Test coverage + agent timeout (timer leak, dup) | REWORK | REWORK | REWORK |
| charming-euclid-da205a | Wash sale + corporate action (strip wash-sale half) | REWORK | REWORK | REWORK |
| compassionate-leakey-f1df27 | Alert dedup (agent timeout dup, withDb skips dedup) | REWORK | REWORK | REWORK |
| focused-ride-99f2dc | Observability (REJECTED dup, no sendAlert, half-open LLM) | MERGE-w-fix | REWORK | REWORK |
| funny-lovelace-275f32 | Local API security (one-line `/web/orders/*` rate-limit) | MERGE-w-fix | MERGE-w-fix | REWORK |
| hopeful-mirzakhani-c9cfa1 | Short selling (margin model wrong, excessLiquidity bloat) | REWORK | REWORK | REWORK |
| hopeful-vaughan-1665f1 | Server-side stops (ADD-leak, fire-and-forget, no tests) | REWORK | REWORK | REWORK |
| hungry-agnesi-f0b6e5 | DB backup (PG_DUMP_PATH dropped, never run) | MERGE-w-fix | REWORK | REWORK |
| inspiring-poitras-be27c7 | Clock check (staleness trap throws every startup) | REWORK | REWORK | REWORK |
| mystifying-visvesvaraya-6c8ca0 | Risk audit (tsc breaks, no tests for 4 gates) | REWORK | REWORK | REWORK |
| objective-roentgen-c58003 | Ingestion (alert spam, polling fallback bug) | REWORK | REWORK | REWORK |
| optimistic-euler-92f96c | Kill switch (backtest leak, CLI/admin dup) | REWORK | REWORK | REWORK |
| peaceful-cannon-d44788 | launchd (agent plist not installed by script) | REWORK | REWORK | REWORK |
| sleepy-ride-bf3c64 | Secrets/runtime channels (partial scrub, stale endpoint) | REWORK | REWORK | REWORK |
| suspicious-mahavira-6a4d53 | Market guard (rails violation, false-positive `\bsuspended\b`) | REWORK | REWORK | REWORK |
| upbeat-rubin-2190af | Fallback agent (cache key leak, INTENT_VERSION not bumped) | REWORK | REWORK | REWORK |
| vibrant-margulis-34746b | Position aging (recordTrade silent null, weekend sweep) | REWORK | REWORK | REWORK |
| vigilant-mcclintock-081b3c | Failure modes (LIVE_ORDERS_ENABLED secret missing) | REWORK | REWORK | REWORK |
| zen-proskuriakova-d3b267 | PDT (sidecar dead code, ADD-scaling undercount) | REWORK | REWORK | REWORK |
| **elegant-galileo-69a953** | DB integrity audit | MERGE | **DO NOT MERGE** | **BLOCK** |
| **suspicious-poincare-d93023** | Per-trader trust score | REWORK | REWORK (close-to-BLOCK) | **BLOCK** |

**Summary: 9 MERGE / 19 REWORK / 2 BLOCK.**

## Why the two BLOCKs

- **elegant-galileo-69a953** — `validateMigrations()` queries `drizzle_migrations` but drizzle-orm's actual table is `drizzle.__drizzle_migrations`. Verified empirically against the running DB. Plus a chicken-and-egg in `db:migrate` (it imports `db/client.ts` which now calls `validateMigrations()` at module load → throws before the migrator can run). Both fixes are non-trivial. Migration filename also collides with main's `0001_chemical_jetstream.sql`.
- **suspicious-poincare-d93023** — Migration filename collides with main. Plus: `index.ts:70` ternary literally returns 0.25 in both branches (`autoPaused ? 0.25 : 0.25`); manual API unpause leaves stale `consecutiveLosses` so trader re-pauses on next loss; API mutation runs in a different process than the runner cache so `invalidateTraderCache` is bypassed. Migration collision alone makes the merge mechanically impossible without rebase.

## Conflict graph (MERGE candidates only)

Files touched by 2+ approved worktrees:

- **`src/broker/ibkr/client.ts`** — three-way conflict
  - `competent-darwin` — symbology (independent)
  - `relaxed-bell` — `creditComboOrderIds` delete on FILLED (in `getOrderStatus`); 402 Set→Map TTL
  - `awesome-liskov` — moves `creditComboOrderIds` from module-scope to per-runtime `IbkrRuntime` field; populates fill data on cancel
  - **Interaction**: `awesome-liskov` and `relaxed-bell` both touch the `creditComboOrderIds` Set; merging awesome-liskov first means relaxed-bell's `delete()` call must be hand-ported to the new per-runtime field.
- **`src/index.ts`**
  - `lucid-zhukovsky` — adds `await checkDiskSpace()` before `acquireLock()`
  - `relaxed-bell` — adds `startMetrics()/stopMetrics()`, awaits `pgPool.end()` on shutdown
  - **Interaction**: different sections; trivial conflict.
- **`src/pipeline/execute-resolved.ts`**
  - `awesome-liskov` — register pending intent for PENDING (single line)
  - `wonderful-hodgkin` — position-sizing wiring
  - **Interaction**: different sections; trivial.

No MERGE candidate touches `drizzle/` so the migration collision is contained to BLOCK list.

## Main's uncommitted state — must address first

Main currently has **51 files modified + 7 untracked**, including:
- Drizzle migration `0001_chemical_jetstream.sql` (planned_exit_date column) + snapshot
- New script `scripts/backfill-trade-risk.ts`
- Two new lessons (`alert-market-window`, `ingestion-subscription-recovery`)
- Risk-check, build-deps, record-trade, trade-risk/quality changes
- Web frontend changes spanning ~17 files

This is in-progress work that was committed somewhere upstream of these worktrees but not yet committed locally. **Cannot merge worktrees onto a dirty tree.**

Options:
1. **Commit main's state as a single "WIP baseline" commit before merging worktrees.** Cleanest. Risk: bundles unrelated work.
2. **Stash main's state, merge worktrees, then unstash.** Stash will conflict with several worktrees. Risk: stash apply gets messy.
3. **Inspect each modified file in main and split into logical commits before merging.** Slowest. Lowest risk.

**Recommended: option (1)** — commit main as a single baseline. Worktree merges will produce clean, isolated commits on top.

## Recommended merge order

Conflict-free first, then resolve interdependencies:

1. **Baseline commit on main** (51 files). Message: `WIP: in-progress changes (risk-check, ingestion, web, planned_exit_date migration)`.
2. **wizardly-swirles** — sidecar Java + dev-up.ts + start-sidecar.sh. Zero overlap.
3. **elegant-margulis** — package.json + lockfiles only. Zero source conflict.
4. **wonderful-hodgkin** — position sizing + small `build-deps.ts` / `execute-resolved.ts` adds.
5. **festive-northcutt** — local-api dashboard query + web panel. Touches `web-queries.ts` (also in main's WIP — conflict expected).
6. **sharp-bhaskara** — agent timeout factoring (`anthropic-agent.ts`, `xai-agent.ts`, `result.ts`, `intents/orchestrator/*`). Zero conflict with other MERGE candidates.
7. **lucid-zhukovsky** — `.gitignore`, `log-rotation.ts`, new `disk-check.ts`, `index.ts` (1 startup line).
8. **competent-darwin** — IBKR symbology. Touches `client.ts` but only the symbology code path.
9. **awesome-liskov** — `client.ts` per-runtime sets + cancel/fill race. **Refactors `creditComboOrderIds` to `IbkrRuntime` field.**
10. **relaxed-bell** — Memory-leak audit. **Will need manual reconciliation** in `client.ts` to apply its delete-on-FILLED to the new per-runtime field; trivial 1-line port. Also conflicts with lucid-zhukovsky in `index.ts` shutdown section.

## Per-merge mechanic

For each worktree:
1. `cd .claude/worktrees/<name>` 
2. `git add -A && git commit -m "<topic>: <one-line summary>"` — produce a single commit on the `claude/<name>` branch.
3. `cd /Users/jason/Workspace/trade-follower-3`
4. `git merge --no-ff claude/<name>` — preserves merge bubble for traceability.
5. Resolve conflicts manually if any. Run `npx tsc --noEmit && npm test` between merges.
6. `git commit` to seal the merge.

## Required actions before each merge

The MERGE-verdict worktrees have small required-fix lists from their reviewers (e.g., redundant RESOLVED badge in festive-northcutt; cosmetic items in awesome-liskov; followup periodic disk-check in lucid-zhukovsky). The reviewers explicitly marked these as **non-blocking** — they can land as post-merge follow-ups.

The 9 MERGE candidates all have:
- `tsc --noEmit` clean
- Existing tests pass
- No `if (isBacktest)` rails violations
- No new shape-plumbing cruft

Quality gates to re-run after each merge: `npx tsc --noEmit && npm test && npm --prefix web run check && npx knip`.

## Out of scope for this merge wave

The 19 REWORK worktrees address real go-live concerns (server-side stops, halt switch, market guard, observability, position aging, PDT, market guard, alert hardening, etc.) but each has at least one specific defect the reviewer flagged. They should be reworked in-place by their authors and re-reviewed before merge.

The 2 BLOCK worktrees should be discarded and re-attempted in fresh worktrees that:
- regenerate the migration onto main's `0001` (now `0002` after baseline commit)
- fix the `__drizzle_migrations` table-name + bootstrap chicken-and-egg in elegant-galileo
- fix the always-0.25 bug, cache invalidation, and stale-streak logic in suspicious-poincare
