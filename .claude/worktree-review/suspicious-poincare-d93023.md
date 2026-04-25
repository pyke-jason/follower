# Worktree Review — `suspicious-poincare-d93023`

## Goal
Add a per-trader trust score that scales position size based on each trader's recent track record, plus an auto-pause that fires after 5 consecutive losses (snap-back after 2 wins). Surfaced on the trader roster (Trust column with `1.00x`/`0.75x`/`0.50x`/`0.25x` badge + `PAUSED` button) and on the trader detail page (full Trust panel with metrics + Unpause).

## Changes
- **Schema (`src/db/schema.ts` + `drizzle/0001_careful_winter_soldier.sql`)** — three new columns on `tracked_traders`: `trust_multiplier real default 1.0`, `auto_paused boolean default false`, `consecutive_losses integer default 0`.
- **`src/trader-trust/index.ts`** — `computeTraderTrustMetrics(trader)` queries closed non-backtest trades within a 30-day lookback, returns `{tradeCount, winRate, avgPnlPerTrade, maxDrawdown, sharpeRatio, consecutiveLosses, multiplier, tier, autoPaused}`. Tier table: HIGH (≥20 trades, WR≥55%, +avg) → 1.0x; MEDIUM (≥10, WR≥45%, +avg) → 0.75x; LOW (≥5, WR≥35%) → 0.5x; UNTESTED → 0.25x. `refreshTrustMultiplier()` persists to the column.
- **`src/trader-trust/auto-pause.ts`** — `checkAndUpdateAutoPause(trader, sendAlert)` reads the most-recent 20 non-backtest closed trades, counts the leading streak, flips `autoPaused` at 5 losses or back at 2 wins, calls `refreshTrustMultiplier()` and `invalidateTraderCache()`.
- **`src/config/traders.ts`** — added `invalidateTraderCache()` to bust the 60s `getTrader()` cache after auto-pause writes.
- **`src/pipeline/build-deps.ts`** — `calculatePositionSize` reads `tc?.trustMultiplier` and `tc?.autoPaused`, multiplies `base.quantity * trustMult` and `Math.floor()`s. `recordTrade` wrapper fires `checkAndUpdateAutoPause(...)` (fire-and-forget) on CLOSE/TRIM/LEG_OFF when `!config.isBacktestScope`.
- **API** — `web/traders/:name` patch accepts `field:'autoPaused'`. `GET /web/traders/:name` returns `trustMetrics`. `TrackedTraderBriefSchema` exposes `trustMultiplier`, `autoPaused`, `consecutiveLosses`.
- **Frontend** — `trader-roster.tsx` adds a `Trust` column with multiplier badge + `PAUSED` button → `setAutoPaused(name, false)`. `views/traders/[name]/page.tsx` adds a `TrustPanel` card (always rendered) and an `AUTO-PAUSED` badge + `Unpause` action.
- **Lesson** — `docs/lessons/2026-04-24-per-trader-trust-score.md` documents the rationale (and notes that the migration was applied to the live DB by hand from a scratchpad because db:migrate couldn't run in the worktree).

## Justification per change

| Change | Pre-live justification |
|---|---|
| Schema columns | Reasonable storage for a per-trader sizing knob the user can override. |
| `computeTraderTrustMetrics` (and the Sharpe/drawdown/avg-pnl bits) | **Bloat.** The sizing decision uses only `multiplier` + `autoPaused`. The other metrics are surfaced on the detail page only. Sharpe on trader-level samples (likely ≤ 20 trades) is statistical theatre. |
| `refreshTrustMultiplier` | OK — keeps the column denormalized so the cached `getTrader()` lookup stays cheap. |
| Auto-pause at 5 consecutive losses | Reasonable safety rail once *some* trades exist. |
| Pipeline `calculatePositionSize` multiplier | The actual sizing change. Single chokepoint, correct location. |
| Auto-pause hook in `recordTrade` | Correct location, but adds a `!config.isBacktestScope` branch in `src/pipeline/` (see Concerns). |
| `invalidateTraderCache()` | Necessary because `getTrader()` has a 60s TTL — without it, an auto-paused trader could still get full size for up to a minute. |
| Frontend Trust column + Trust panel | UI is fine. PAUSED action / Unpause button work and toast. Reuses existing primitives. |

## Concerns

1. **The feature has nothing to compute against pre-live.** Main is pre-live; the audit framing confirms this. The lesson author's claim that "the system went live recently" is fiction. With zero closed live trades, every one of the 775 tracked traders falls into UNTESTED (0.25x). The author acknowledges this in the lesson without questioning it — but **on day one of going live this means every trade is sized at 25% of intended risk**, not because of bad track record but because *no track record exists*. That's a major silent behavior change introduced as a "safety feature." Expected behavior on go-live should be 1.0x until a track record disqualifies someone, not 0.25x by default.

2. **0.25x can floor to qty=0.** `calculatePositionSize` does `Math.max(0, Math.floor(base.quantity * trustMult))`. The base sizer normally has `Math.max(rawQty, 1)` floor; the trust multiplier bypasses it. Any small base (e.g. high-priced options where 5% notional yields qty 1–3) becomes qty 0 → `execute-resolved.ts:502` returns `executed: false`. Combined with concern (1), some signals will silently no-op on go-live. No alert, just a `reason` string. The lesson does not mention this.

3. **`isBacktestScope` branch in `src/pipeline/build-deps.ts`** — line 226: `if (result && isClose && !config.isBacktestScope) { checkAndUpdateAutoPause(...) }`. This is exactly the rails violation called out in `CLAUDE.md` and `pipeline-execution.md`: *Never add `if (isBacktest)` branches in `src/pipeline/`*. The branch is also redundant — `auto-pause.ts` already filters with `NOT LIKE 'bt:%'` at the SQL level, so the check would be a near-no-op in backtest scope anyway (one extra query per close). The right fix: drop the gate, or make trust-update a `BrokerService`/runner concern, not a pipeline concern.

4. **`build-deps.ts` `calculatePositionSize` is not gated** — the trust multiplier IS applied during backtests (no `isBacktestScope` check on the multiplication itself). That means a backtest's sizing depends on the live `tc.trustMultiplier` value at the moment the backtest runs, which is non-deterministic and contaminates backtest results. This is a worse rails violation than (3) because it silently couples live state into backtest output.

5. **Multi-stat surface area is bloat.** `TraderTrustMetrics` carries 9 fields; sizing uses 2. The detail page renders Sharpe and drawdown computed from ≤ 20 closed trades — a sample size where Sharpe is meaningless. One stat (recent win rate, or just count + winRate) would do. The lesson rules (`lessons.md`) explicitly warn against shape-plumbing cruft and inventing parallel types — `TraderTrustMetricsSchema` is duplicated in `http-schemas.ts` rather than imported from `src/trader-trust/index.ts`.

6. **Migration already applied by hand to live DB** (per the lesson "Watch Out"). The migration file is in the worktree but the production DB has the columns added via a scratchpad script, which means the journal in main does not match the actual DB state. Merging this PR will run `0001_careful_winter_soldier.sql` against a DB where the columns already exist — `ALTER TABLE ... ADD COLUMN` will fail with "column already exists." This is a real merge hazard.

7. **No tests.** Tier thresholds, the 5-loss/2-win streak counter, and the 0-quantity edge case all deserve unit tests. The streak counter has a subtle pnl=0 → loss treatment that should be pinned.

8. **`getTrader()` only loads enabled traders** (`where(eq(enabled, true))`). If a disabled trader gets re-enabled, the trust columns flow through, but the auto-pause writer in `auto-pause.ts` doesn't filter by `enabled`. Mostly harmless; flagging for completeness.

## Verdict: REWORK

The feature has the right shape (sizing knob + pause flag, single chokepoint in `calculatePositionSize`, fire-and-forget update on close, UI surfacing). But it ships pre-live in a state that *changes the meaning of going live*: every signal sized to 25% of intended risk on day one, with some signals silently no-op'ing to qty 0. That is not a safety feature — it is a behavior change in safety clothing. Combined with the schema migration being already-applied to the live DB outside the migration journal, the rails violation in pipeline code (both the `isBacktestScope` branch and the un-gated trust multiplier contaminating backtests), and the absence of any tests, this is not merge-ready. The bones of the design are reasonable; reworked tightly, this could ship.

## Required fixes

1. **Default UNTESTED to 1.0x, not 0.25x.** Pre-live, no trader has a track record, and quartering every trade is the wrong default. Reserve 0.25x for `auto_paused`. The author's argument ("conservative until track record builds") only holds if there's a way to *get* a track record without trading at full size — which there isn't, since live signals are the only source.
2. **Drop the trust multiplier in backtest scope.** Either gate `tc.trustMultiplier` application by `!config.isBacktestScope` (still rails-violating but at least correct), OR — preferred — move the multiplier to a `BrokerService` or runner concern so the pipeline stays scope-blind. Backtest results must not depend on live trust state.
3. **Drop the `!config.isBacktestScope` gate around `checkAndUpdateAutoPause`.** The auto-pause SQL already filters non-backtest channels; the pipeline branch is redundant rails violation. Remove the gate (and remove the unused redundancy with no behavior change).
4. **Floor the post-multiplier quantity to 1** when the base quantity was ≥ 1, OR explicitly emit a `SKIPPED_TRUST_FLOOR` decision when it goes to 0. Silent no-ops at the sizer are a debugging black hole.
5. **Resolve the migration drift.** Either revert the by-hand changes on the live DB and let `db:migrate` apply cleanly, or rename this migration to a no-op `IF NOT EXISTS` form. As written it will fail to apply on merge.
6. **Trim `TraderTrustMetrics` to what's actually used.** Drop Sharpe and max drawdown (or move them to a separate "stats" endpoint). Tier sample sizes are too small to make Sharpe meaningful, and sizing only reads `multiplier` + `autoPaused`. Re-export the type from `src/trader-trust/index.ts` instead of redeclaring in `http-schemas.ts` (per `lessons.md`).
7. **Add tests** for: tier threshold boundaries (4/5/9/10/19/20 trades), the streak counter (including pnl=0), the cache invalidation, and the qty=0 floor behavior.

## Reviewer verdict

**REWORK** (leaning toward BLOCK on the migration alone).

### Agreements
- Concern (1) is the headline. With main pre-live and 775 UNTESTED traders pinned to 0.25x, this ships as a 75% global throttle wearing safety clothing, which is materially different from go-live intent. The lesson's "system went live recently" is contradicted by the audit framing.
- Concern (2) is real and verified. `Math.floor(small * 0.25) = 0`, and `execute-resolved.ts:502` returns `executed: false` silently. Combined with (1), a non-trivial fraction of day-one signals will no-op without an alert.
- Concern (4) is real and worse than (3). `calculatePositionSize` is unconditionally trust-aware, and `src/backtest/runner.ts:205` does not pass `isBacktestScope: true`. Backtests will read live `tc.trustMultiplier` (currently 0.25x for everyone), contaminating sizing and making backtests non-deterministic across runs.
- Concern (3) verdict stands but for a different reason than the thesis claims: because backtest does not set `isBacktestScope`, the gate in `recordTrade` is *not* dead — `checkAndUpdateAutoPause` fires during backtests. The SQL filter prevents streak corruption, but each backtest close still issues a query and a `refreshTrustMultiplier()` write that recomputes live trust state. That is a more serious cross-contamination than the thesis describes.
- Sharpe/MDD on <=20 samples is theatre; `TraderTrustMetricsSchema` is duplicated in `http-schemas.ts` instead of imported from `src/trader-trust/index.ts`, violating the shape-plumbing rule in `.claude/rules/lessons.md`.

### Disagreements / additions
- The thesis frames migration drift as "applied by hand to live DB." The bigger problem is a hard merge collision: main already has `drizzle/0001_chemical_jetstream.sql` (planned_exit_date column), and the worktree introduces its own `drizzle/0001_careful_winter_soldier.sql`. Both meta snapshots are named `0001_snapshot.json`. This will not just fail to apply — it will not even merge cleanly, and rebasing requires renaming to `0002_*` and regenerating the snapshot. This is closer to BLOCK than REWORK.
- Concern (8) (disabled traders) is a non-issue: `getTrader()` filters `enabled=true`, but `auto-pause.ts` writes by `name` regardless. Harmless.

### Missed by the thesis
- `auto-pause.ts:52` streak counter treats `pnl <= 0` as a loss including `pnl === 0`. A scratch trade flips a streak. Worth a test, but also worth a deliberate decision (push to break-even = neutral, not loss).
- `invalidateTraderCache()` is process-local. Local API and live runner are separate processes; the API's PATCH to `autoPaused` updates DB but does NOT invalidate the runner's cache. Manual unpause from the dashboard takes up to 60s to take effect in the live trader. The 60s lag is the entire reason `invalidateTraderCache` exists, and the API write path bypasses it.
- `refreshTrustMultiplier()` writes the multiplier but not `consecutiveLosses` (auto-pause writes both); the API's `autoPaused=false` mutation does not clear `consecutiveLosses`, so manual unpause leaves a stale streak that can re-trigger on the next loss.

### Verdict
REWORK. Required fixes from the thesis are correct; add (a) migration rename to `0002_*` with regenerated snapshot, (b) gate `calculatePositionSize` trust-mult application on `!isBacktestScope`, (c) invalidate cache or expose IPC on API mutations, (d) clear `consecutiveLosses` on manual unpause. Do not merge until the migration collision is resolved.

## Reviewer verdict (independent pass — 2026-04-24)

**BLOCK.**

### Agreements
- Pre-live framing is the headline failure. Tier table pins UNTESTED → 0.25x AND `tradeCount === 0` short-circuit (`index.ts:62-74`) also returns 0.25x. Pre-live, every tracked trader gets quartered sizing on day one — not a safety rail, a silent throttle. Worse, `index.ts:70` literally writes `multiplier: autoPaused ? 0.25 : 0.25` (a tell that the author cargo-culted the ternary without thinking).
- Backtest contamination is verified and severe. `runner.ts:205-219` does not pass `isBacktestScope`, so `calculatePositionSize` reads live `tc.trustMultiplier` mid-backtest. With UNTESTED defaulting all 775 traders to 0.25x, every backtest run from this branch is silently 1/4-sized. Backtest output stops being a function of code+inputs.
- Pipeline branch in `recordTrade` (`build-deps.ts:226`) violates the explicit rail in `CLAUDE.md` (the "most-violated rule"). And because backtest doesn't set the flag, the gate doesn't even fire — auto-pause writes happen during backtests, mutating live `trackedTraders` rows. The `NOT LIKE 'bt:%'` SQL filter saves streak math but doesn't save the `refreshTrustMultiplier()` write that runs against live state.
- Migration collision is verified: main has `0001_chemical_jetstream.sql` (planned_exit_date), worktree has `0001_careful_winter_soldier.sql`. Both journals claim idx 1; both `meta/0001_snapshot.json` files exist. This will not merge — git itself will refuse the snapshot collision and `db:migrate` would fail even after manual rename without a regenerated snapshot.
- Silent qty=0: `execute-resolved.ts:503` returns `executed: false` with reason `Position sizer returned qty=${size.quantity}`. Combined with 0.25x default, low-quantity signals (high-priced options, small accounts) silently no-op with zero alerting.
- Sharpe/MDD theatre on ≤20 trades; `TraderTrustMetricsSchema` re-declared in `http-schemas.ts` rather than imported from `src/trader-trust/index.ts` — direct violation of `lessons.md` shape-plumbing rule.

### Missed by thesis (additions)
- `auto-pause.ts:50-57` streak counter has a bug: the loop increments `consecutiveWins` only when `consecutiveLosses === 0` AND `pnl > 0`, and `consecutiveLosses` only when `consecutiveWins === 0` AND `pnl <= 0`. A trader whose most-recent trade is a scratch (pnl === 0) with prior wins will be counted as "1 loss," resetting any win streak silently. Pnl===0 should be neutral (or excluded), not a loss.
- `refreshTrustMultiplier()` does not clear `consecutiveLosses`; only `checkAndUpdateAutoPause` writes both. The API path (`web-mutations.ts:597`) writes `autoPaused: false` only, leaving the streak counter stale — next loss can re-arm the auto-pause immediately. Manual unpause is not a clean reset.
- Cache invalidation is process-local. `invalidateTraderCache()` only clears the cache in the runner process. The API mutation runs in `local-api` (separate process per `npm run up`) — its DB write is not visible to the runner cache for up to 60s. The whole reason `invalidateTraderCache` exists is bypassed by the user-facing unpause path.

### Verdict reasoning
This ships pre-live with: a 75% global throttle disguised as a safety feature, a hard git/migration collision with main, a rails violation in pipeline code, backtest contamination from live state, statistical theatre on tiny samples, and zero tests for any of the streak/threshold logic. The shape of the design is reasonable; the execution is not merge-ready. **BLOCK** rather than REWORK because the migration collision alone makes a merge mechanically impossible — a rebase + snapshot regeneration is required before any of the other fixes even matter.
