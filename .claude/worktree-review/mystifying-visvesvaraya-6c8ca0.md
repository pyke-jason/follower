# Audit: mystifying-visvesvaraya-6c8ca0 — pre-live-risk-audit

## Goal

Harden the single enforcement point (`src/orders/risk-check.ts`) against known day-1 failure modes surfaced by a backtest that hit two margin calls. Tighten `LIVE_RISK_DEFAULTS`, close two real gaps (credit-spread notional bypass, missing margin cushion gate), and switch opening IBKR orders from GTC to DAY so a crashed bot cannot wake up next session holding a stale unfilled entry.

## Changes

1. `src/orders/risk-check.ts`
   - New `positionRiskNotional(trade)` — for PCS/CCS computes `(width − credit) × qty × 100` (max-loss), falls back to `notionalValue()` otherwise. Used in the leverage-cap sum.
   - New gate "margin cushion": blocks when `(equity − maintenanceMargin) / equity < config.minMarginCushionPct`. Skipped silently when either `minMarginCushionPct` is null, `maintenanceMargin` is null, or `equity <= 0`.
   - New dep `getMaintenanceMargin: () => Promise<number | null>` (required — no `?`, per rails rule that `RiskCheckDeps` has no optional fields).
   - New result field `marginCushionPct?: number`. Reason string formatted with dollars + percent.

2. `src/config/risk-defaults.ts`
   - `LIVE_RISK_DEFAULTS.maxTotalPositions: 100 → 20`.
   - Both defaults get `minMarginCushionPct: 0.20`.

3. `src/pipeline/build-deps.ts`
   - Wires `getMaintenanceMargin` via `broker.getAccountBalance().maintenanceMargin ?? null`. Identical for live (IBKR populates `summary.maintenanceMargin`) and backtest (`sim-broker` line 880).

4. `src/broker/ibkr/client.ts`
   - Combo (`buildComboOrderBody`) and single-leg (`placeOrder`): `tif = params.isClosing ? 'GTC' : 'DAY'`. Opens expire end-of-day, closes persist.

5. `docs/lessons/2026-04-24-pre-live-risk-audit.md` — new lesson file with rationale and a day-1 parameter recommendation block.

## Justification per change

- **Credit-spread notional bypass (positionRiskNotional):** Real, verified bug. `notionalValue(entryPrice, qty, strategy)` with `entryPrice = net credit` under-counts PCS/CCS exposure by 5–10× (lesson example: 10-wide PCS, $1 credit, 5 contracts → old sum $500, max-loss $4,500). Exactly the sort of silent cap bypass that causes the backtest margin calls the author is reacting to. Fix uses existing helpers (`getSpreadWidth`, `parseLegs`, `contractMultiplier`) — no new infra.

- **`maxTotalPositions` 100 → 20:** The live value was unexplained and 5× higher than backtest, which made the prior backtest results meaningless as a live risk envelope. Aligning both to 20 is correct single-user-appropriate scope.

- **Margin cushion gate:** `maintenanceMargin` was already returned by `broker.getAccountBalance()` (both IBKR and sim) and never consumed. Gating new opens on cushion is the standard "don't approach forced-liquidation" control. Cheap to add because the signal is already piped in.

- **DAY TIF on opens:** Directly addresses a crash-recovery hazard. Opening chase profiles already carry `cancelAfterSec`, so DAY is redundant under happy-path — but `cancelAfterSec` only fires if the process is alive. DAY is the insurance policy. The asymmetric split (closes still GTC) is correct and matches the existing invariant in `.claude/rules/pipeline-execution.md` ("cancelled close leaves an unhedged position").

## Concerns

1. **BLOCKS THE MERGE: existing test file breaks tsc.** `src/orders/risk-check.test.ts` exists in `main` (it's in the initial `git status` as a `??` untracked file but it has since been staged into the working tree). That test's `makeDeps()` omits `getMaintenanceMargin`. Because the worktree makes `getMaintenanceMargin` required on `RiskCheckDeps`, merging produces:
   ```
   src/orders/risk-check.test.ts(46,3): error TS2322: Types of property 'getMaintenanceMargin' are incompatible.
     Type '(() => Promise<number | null>) | undefined' is not assignable to type '() => Promise<number | null>'.
   ```
   Verified by copying the test into the worktree and running `tsc`. The worktree's own `tsc --noEmit` passes only because the worktree doesn't contain the test file. Must update `makeDeps` before merge.

2. **No new tests for any of the four fixes.** Per rubric 6 ("a risk check with no test is theatre"): no `positionRiskNotional` unit test (covers the exact PCS/CCS numeric case the lesson highlights), no margin-cushion gate test, no DAY/GTC assertion in `buildComboOrderBody`. The existing risk-check.test.ts didn't even have cases for the `minMarginCushionPct` config value. Given this is a pre-live risk audit, the absence of a single new test across four gates is the biggest weakness of the change.

3. **Reason-string debug output uses the old `notionalValue`.** In `risk-check.ts:182`, the "top 3 positions" debug line for `notionalBlocked` uses `notionalValue(...)` per-position, but the sum it was blocked against uses `positionRiskNotional(...)`. For PCS/CCS positions the debug lines will show credit-received dollars while the gate fired on max-loss dollars — confusing during live incident triage. Cosmetic, not a safety issue.

4. **IBKR already provides `cushion` natively.** `AccountBalance.cushion` is populated at `src/broker/ibkr/client.ts:475` from IBKR's `reqAccountUpdates`. The worktree re-derives `(equity - maintenance)/equity` rather than consuming `cushion`. Functionally equivalent for IBKR, and the hand-computed version is the only workable path for `sim-broker` (which doesn't compute `cushion`), so this is fine — but the duplication is worth a comment. Not blocking.

5. **Silent skip when `getMaintenanceMargin()` returns null.** Matches the existing `startingEquity` anti-pattern the lesson itself calls out under "Watch Out". At IBKR startup before the account summary arrives, or if the sidecar hiccups, `null` will disable the gate without log. Lesson correctly flags this for follow-up but doesn't fix it now.

6. **Margin-call safety gap in the backtest remains.** The lesson acknowledges `runner.ts:334` only logs margin calls; the gate added here is decision-time, so backtests still "survive" margin calls rather than halting. Out of scope for this worktree but the audit's own premise (backtest hit two margin calls) means the backtest-halt hole is the root cause and is still open.

7. **DAY TIF for opens in combo orders — no IBKR smoke test documented.** The TIF switch is simple, but combo BAG orders with DAY are an interaction worth a one-shot paper-account check before go-live. No Playwright or live-dev verification is referenced in the lesson. Given this is a pre-live merge, a `/verify` pass would have caught whether TWS rejects anything.

8. **Rails compliance (rubric 2 & 5):** No `if (isBacktest)` added in `src/orders/` or `src/pipeline/`. `RiskCheckDeps` field is non-optional. The gate runs identically in backtest and live (only `getReconciliationAlertCount` still short-circuits for backtest, which was pre-existing). Clean.

## Verdict: REWORK

Four substantive, well-reasoned fixes, each pointed at a named real failure mode, all upstream at the single enforcement point, rails-clean, no `isBacktest` branching. This is the right worktree to land before go-live.

But it is not merge-ready. It ships a breaking type change to `RiskCheckDeps` without updating the only test file that constructs one, so `npx tsc --noEmit` fails immediately post-merge. And four new risk behaviours land with zero test coverage, which on a go-live audit is exactly the pattern the rubric calls "theatre." The fixes are good; the packaging isn't. Fix the tsc break and add a minimum test per gate, then MERGE.

## Required fixes

1. **Must (blocks merge).** Update `src/orders/risk-check.test.ts` `makeDeps()` to include `getMaintenanceMargin: async () => null` (or `100_000` where relevant). Verify `npx tsc --noEmit && npm test -- risk-check` passes.

2. **Must (risk-check theatre otherwise).** Add tests:
   - `positionRiskNotional`: PCS 10-wide, $1 credit, qty 5 → $4,500 not $500; debit/STOCK paths unchanged (delegates to `notionalValue`).
   - Margin-cushion gate: blocks when `equity=100k maintenance=85k cushion=15% < 20%`; allows at `maintenance=70k cushion=30%`; skipped when `getMaintenanceMargin` returns null (regression guard for the silent-skip concern).
   - `buildComboOrderBody`: `isClosing: false → tif === 'DAY'`; `isClosing: true → tif === 'GTC'`.

3. **Should.** Rewrite the notional-blocked debug string at `risk-check.ts:182` to use `positionRiskNotional` so the top-3 positions render in the same currency as the gate decision. Also surface the constituent legs (or at least strike width) for credit spreads so a live operator can decode "$4,500 notional for a $1 credit" at a glance.

4. **Should (day-1 hygiene, lesson-flagged).** Emit a single `log.warn` when the margin-cushion gate is silently skipped because `getMaintenanceMargin` returned null while `minMarginCushionPct` is configured. Same pattern should eventually apply to the `startingEquity` skip. Tiny change, buys observability.

5. **Nice-to-have.** Prefer `balance.cushion` from IBKR when present (live accuracy); fall back to the hand-computed ratio for sim. Or add a comment explaining why we don't.

## Reviewer verdict

Tried to falsify the thesis. Held up on all load-bearing claims.

**Confirmed real, not theatre:**
- `positionRiskNotional` for PCS/CCS is a real bug fix. Pre-change reducer called `notionalValue(entryPrice, qty, strategy)` where `entryPrice` is the net credit for credit spreads, so 10-wide PCS @ $1 credit × 5 = $500 in the gate, vs. $4,500 true max-loss. Numeric math verified against `contractMultiplier` and `getSpreadWidth`. Gate bypass was real.
- `maxTotalPositions: 100 → 20` aligns live with backtest. 100 was unjustifiable for a single-user copy bot and would have let the gate never fire pre-margin-call.
- Margin-cushion gate consumes a signal (`balance.maintenanceMargin`) that was already piped in and never used. IBKR populates it at `src/broker/ibkr/client.ts:474`; sim-broker populates it too. Rails-clean.
- DAY/GTC asymmetry on opens vs closes is correct per `.claude/rules/pipeline-execution.md` ("a cancelled close leaves an unhedged position").

**Confirmed blocking:**
- Reproduced the tsc break. Copied `main`'s `src/orders/risk-check.test.ts` (which is untracked in main but present) into the worktree and ran `npx tsc --noEmit`:
  ```
  src/orders/risk-check.test.ts(46,3): error TS2322: Types of property 'getMaintenanceMargin' are incompatible.
    Type '(() => Promise<number | null>) | undefined' is not assignable to type '() => Promise<number | null>'.
  ```
  The worktree's own `tsc` only passes because it doesn't contain the test. On merge, the main gate fails immediately. Thesis is correct.
- Verified the debug-reason discrepancy at `risk-check.ts:182`: still uses `notionalValue`, not `positionRiskNotional`. Cosmetic but real.

**Rails compliance:**
- No `if (isBacktest)` added in `src/orders/` or `src/pipeline/`. The sole `config.isBacktestScope` check in `build-deps.ts:154` is pre-existing and is on the `config` object inside the factory boundary, which the rule explicitly allows ("Differences belong in `BrokerService` implementations or the caller that builds `ResolvedPipelineDeps`").
- `RiskCheckDeps.getMaintenanceMargin` is non-optional, matching the rule "`RiskCheckDeps` has NO optional fields." `minMarginCushionPct` is on `RiskCheckConfig` (different type), and optional there is fine — it disables the gate when unset, which is the intended opt-in shape.
- The gate runs identically in backtest and live. Sim-broker populates `maintenanceMargin`, so `BACKTEST_RISK_DEFAULTS.minMarginCushionPct: 0.20` will actually fire in backtests — good, this is the "parity" property the thesis' own lesson hinges on.

**Test gap stands.** Four new risk behaviours, zero new tests. For a pre-live risk audit this is the weakest point and the thesis flags it correctly. The existing `risk-check.test.ts` doesn't even cover the old `notionalValue`-based gate for credit spreads, so there's no regression net at all.

**Verdict agreement: REWORK.** The thesis's diagnosis matches the code. Required-fixes list is complete; I have nothing to add. Fix the tsc break, add a test per gate, then MERGE.

## Reviewer verdict

**REWORK** — independent re-audit, tried to falsify, thesis holds.

**Agreements:**
- `positionRiskNotional` is a real gate-bypass fix. Verified math: 10-wide PCS @ $1 credit × 5 = $4,500 max-loss vs. $500 from `notionalValue(entryPrice=credit, qty, strategy)`. Pre-change reducer line was the only consumer; replaced cleanly. Uses `parseLegs` + `getSpreadWidth` (existing helpers). Falls back to `notionalValue` for STOCK/single-leg/debit, so non-credit paths are byte-identical.
- `LIVE_RISK_DEFAULTS.maxTotalPositions: 100 → 20` is correct for a single-user $25–50k account. 100 was unjustifiable and would have rendered the gate inert pre-margin-call. Now matches `BACKTEST_RISK_DEFAULTS`, restoring envelope parity.
- Margin-cushion gate consumes `maintenanceMargin` already populated by both `IbkrClient` (`src/broker/ibkr/client.ts:474`) and `sim-broker` (line ~880). Wired through `build-deps.ts:149` identically for live and backtest. Math is `(equity − maintenance) / equity < minPct`, which matches the standard cushion formula.
- DAY/GTC asymmetry: closes stay GTC (correct — `pipeline-execution.md` states "a cancelled close leaves an unhedged position … must persist"), opens become DAY so a crashed bot doesn't wake holding a stale entry. Applied to both `buildComboOrderBody` and single-leg `placeOrder`. Asymmetric and correct.

**Disagreements:** None on substance. The thesis's tone undersells one point: the silent skip when `getMaintenanceMargin()` returns `null` is a real day-1 hazard, not just a follow-up. IBKR's `reqAccountUpdates` can return `null` cushion for ~seconds at startup, and during that window the gate is silently disabled. A `log.warn` (thesis "Should #4") is genuinely worth requiring, not nice-to-have.

**Missed by thesis:**
- Reviewer-verdict block (lines 81–107) makes the same factual claims as the body but adds no new findings — appears to be a prior reviewer's pass merged into the doc. Not load-bearing; flagging only because it makes the doc look pre-decided.
- `marginCushionPct` is rounded to 2 decimal places (`Math.round(... × 10000) / 100`) and stored as a percentage (e.g. `15.23`), but the gate compares `marginCushionPct / 100 < config.minMarginCushionPct`. Works, but the field's mixed unit (percent in the result, fraction in the config) is a future foot-gun. Worth normalizing to one unit.
- No assertion that `BACKTEST_RISK_DEFAULTS.minMarginCushionPct: 0.20` won't immediately block backtest opens once `sim-broker.maintenanceMargin` becomes non-trivial. Thesis assumes parity is the goal; if existing backtests were tuned without this gate, they may now fail differently. Worth a single backtest smoke before merge.

**Rails:** Clean. No new `if (isBacktest)` in `src/orders/` or `src/pipeline/`. The pre-existing `config.isBacktestScope` short-circuit at `build-deps.ts:154` is on the factory's config, which `pipeline-execution.md` explicitly permits. `RiskCheckDeps.getMaintenanceMargin` is non-optional per the "no optional fields" rule.

**Verdict:** REWORK. Reproduced tsc break. Four gates, zero tests, on a pre-live risk audit, is theatre. Fix tsc + add the three minimum tests (positionRiskNotional credit-spread case; cushion block/allow/null-skip; combo TIF DAY vs GTC), then MERGE.
