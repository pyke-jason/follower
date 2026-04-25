# Worktree Review: wonderful-hodgkin-592a54

## Goal

Make position sizing safe for going live by (a) handling naked short options correctly (premium-paid is wrong for short risk), (b) refusing to auto-size genuinely unbounded risk (naked short calls), and (c) gating naked short option orders on margin cushion before order entry. Adds the first real test coverage for the position sizer.

## Changes

- `src/position-sizing/index.ts` — Threads optional `direction` into `SizingParams`. New `RiskResult` discriminated union allows `riskPerUnit()` to either return a numeric per-unit risk OR signal `{ skip: true, reason }`. Naked short call returns `skip` (unbounded). Naked short put computes risk = `strike - premium` (max-loss if underlying goes to 0). Long options / stock / debit spreads keep `entryPrice` as risk. Credit spread block was extracted to top of function (refactor, not behavior change).
- `src/position-sizing/index.test.ts` (new, 211 LOC) — 15 tests across 8 describe blocks covering: long call/put, naked short call (rejected), naked short put (strike-based), PCS, CCS, CDS, PDS, stock, maxQuantity cap. Includes the BSX 60/55 PCS @ $0.30 fixture from the trader cookbook.
- `src/pipeline/build-deps.ts` — Before sizing a naked short CALL/PUT, reads `balance.cushion` from the broker; alerts `warning` below 10%, alerts `critical` and returns `quantity: 0` below 5%. Cushion check is gated by `balance.cushion != null` so SimBroker (which doesn't populate cushion) is silently skipped. Adds `direction` to the sizer call.
- `src/pipeline/execute-resolved.ts` — Adds `direction: string` to the `calculatePositionSize` input type and forwards `direction` (already in scope from `deriveDirection(signal.legs)`).
- `src/config/risk-defaults.ts` — Two new exported constants: `SHORT_OPTION_CUSHION_WARN = 0.10`, `SHORT_OPTION_CUSHION_BLOCK = 0.05`.

## Justification per change

**Position sizer fix (naked short put).** The pre-existing code computed risk = `entryPrice` (the premium received) for ALL non-credit-spread strategies, including naked short puts. For a $490-strike short put sold for $1.50 against $100k equity at 5% notional, the buggy code would size by $150/contract risk → 33 contracts. True max-loss is `(strike − premium) × 100 = $48,850/contract`, which sizes to 1 contract (correctly clamped by min-1). The 33→1 contract gap is two orders of magnitude. This is a must-fix before live.

**Naked short call refusal.** A naked short CALL has theoretically unbounded risk; no honest sizing function can compute it. Returning `quantity: 0` with a "manual sizing required" reason is correct — better to drop the signal than to lie. Critical for go-live.

**Cushion guard.** IBKR populates `cushion = (equity - maintenanceMargin) / equity` via `reqAccountUpdates()`. Margin-call territory starts when cushion ~5%; brokers liquidate at 0%. Refusing naked shorts when cushion is already thin is the right call. Warn-then-block thresholds are sensible.

**Test file.** First real coverage for the sizer. Drives all 6 strategy buckets and the maxQuantity cap. Includes a fixture that matches a real trader signal (BSX 60/55 PCS @ $0.30 → 10 contracts at $5k risk budget).

## Concerns

1. **Cushion path is untested.** The new code in `build-deps.ts` (block / warn / pass-through) has no test. If the threshold logic regresses (e.g. `<` flipped to `<=`, severity flipped, alert messages swapped), nothing catches it. A small unit test against a stub broker with `cushion: 0.04 / 0.07 / 0.15` would close this gap cheaply.

2. **`direction` is stringly-typed at the pipeline boundary.** `ResolvedPipelineDeps.calculatePositionSize` accepts `direction: string` and `SizingParams.direction?: string`, even though the canonical type is `Direction = 'LONG' | 'SHORT'`. The string default `'LONG'` in the destructure is a silent fallback that could mask a missing/wrong direction at the callsite. Tightening to `Direction` (or `'LONG' | 'SHORT'`) is one-line per file and gives compile-time enforcement.

3. **Naked short put fall-through is dead code in practice but documented as conservative.** The `if (strike != null && strike > 0)` block falls through to `return { value: entryPrice }` if strike is missing. For a SHORT PUT, the legs always include the option leg with strike — this branch is unreachable in real orchestrator output. The comment frames it as "conservative" but it would actually under-size dangerously (treating short-put risk as premium). Either assert non-null and throw, or document why "fall-through" is acceptable. Not blocking.

4. **`SHORT_OPTION_CUSHION_*` constants live in `risk-defaults.ts` but the gate runs in `build-deps.ts`.** This is fine but it's the kind of cross-cutting check that arguably belongs alongside `checkRiskLimits`, not in the sizer-prep step. Bolting margin checks onto the sizer mixes concerns: the sizer's pre-check now blocks orders, while `checkRiskLimits` (which exists for this purpose) doesn't see the cushion. Not a rails violation but the next person looking for "where do we block trades" won't find this.

5. **No coverage for `equity = 0` or `entryPrice <= 0` corner cases.** Not deal-breakers — the existing code returns qty 0 for `entryPrice <= 0` — but a single regression test would lock that behavior.

6. **Lesson file not written.** CLAUDE.md says "After every implementation session... create a lesson file". Worktree adds a real behavioral change but no `docs/lessons/2026-04-24-position-sizing-naked-shorts.md`. Trivial to add.

## Verdict: MERGE (with one fix)

This is a real, narrowly-scoped, go-live-critical fix. The pre-existing sizer would have under-sized naked short puts by ~30x and under-priced naked short call risk to zero — both are loss-of-account bugs in a system that copies trades autonomously. The fix is correct, deterministic, has 15 unit tests, no `if (isBacktest)` branches anywhere, and respects the broker abstraction (cushion-gated by null check, so SimBroker is unaffected). Typecheck clean, full test suite (580 tests) passes.

The single stop-the-merge issue is the **stringly-typed `direction`** in `ResolvedPipelineDeps` and `SizingParams` — once committed, this opens the door to "did we pass 'short' or 'SHORT'?" string-comparison bugs. Tighten the type. After that, ship it.

## Required fixes

1. **Tighten `direction` to `Direction` type** in `src/pipeline/execute-resolved.ts:96`, `src/position-sizing/index.ts:22`, and the `SizingParams` destructure default. Import `Direction` from `intents/orchestrator/types.js` in the sizer. (Already imported in execute-resolved.)

## Recommended (not blocking)

2. Add a unit test for the cushion gate in `build-deps.ts` (3 cases: `< BLOCK`, `< WARN`, normal). Use a stub broker.
3. Add a lesson file at `docs/lessons/2026-04-24-position-sizing-naked-shorts.md` with Problem / Decision / Key Files / Watch Out per CLAUDE.md convention.
4. Consider moving the cushion gate into `checkRiskLimits` (or alongside it) so all "should this order be blocked?" logic lives in one place. Optional, but the next person tracing a blocked order will start there.

## Reviewer verdict

**APPROVE (with one tightening).**

### Agreements
- Tests pass (15/15, 4ms). Math verified by hand: BSX 60/55 PCS @ $0.30 → width $5 − $0.30 = $4.70, $470/contract, floor($5000/$470) = 10. Long call $2.50 → $250/contract → 20. Short put 490 strike @ $1.50 → ($490−$1.50)×100 = $48,850/contract → floors to 0, min-clamps to 1. All correct.
- No `if (isBacktest)` branches introduced in `src/pipeline/execute-resolved.ts`, `src/pipeline/build-deps.ts`, or `src/position-sizing/index.ts`. Pre-existing `isBacktestScope` references are unchanged. Cushion gate uses `balance.cushion != null` — SimBroker leaves cushion undefined (verified `src/broker/types.ts:81`), so backtests silently bypass the gate via the broker abstraction. Rails-clean.
- Naked short call refusal is correct (unbounded risk). Naked short put strike-based risk is correct (strike − premium × 100). The 33→1 contract gap on short puts is a real loss-of-account bug; this is a must-fix before live.
- Cushion gate uses real IBKR field (`AccountSummary.cushion` from `reqAccountUpdates`, populated at `src/broker/ibkr/client.ts:469`).
- Defaults sane for $25-50k single-user: 5% notional → $1,250-$2,500 per trade; MAX_CONTRACTS=20 prevents runaway sizing on cheap options; cushion 10%/5% match conventional IBKR margin-warning levels.

### Disagreements
- Thesis labels the `direction: string` typing as "stop-the-merge". I treat it as recommended-but-non-blocking: every callsite passes `deriveDirection(signal.legs)` which returns `Direction`. The string fallback default `direction = 'LONG'` is the only soft spot, and it only fires when callers omit the field — currently nobody does. Tighten when convenient; not a merge blocker.

### Missed
- Steps prompt asked about edges: zero buying power, weekly expiry, deep ITM, 0 DTE, spread margin. None are covered by the new tests. The sizer doesn't currently consume DTE/moneyness/buying-power inputs, so most aren't applicable to *this* sizer — but `equity = 0` and `entryPrice <= 0` are real edges that the code handles and could be locked with one line of test each. Spread margin (Reg-T vs portfolio margin) is a separate concern outside the sizer; the credit-spread test correctly uses width − premium which matches Reg-T defined-risk margin.
- `riskPerTrade` field for the short-put min-clamp case returns `1 × 488.50 × 100 = $48,850` — that is 48.85% of equity. The sizer reports this without flagging, even though it exceeds the 5% target by ~10x. A naked short put on a $490 strike against $100k equity probably shouldn't auto-place at all when min-clamp lifts qty above the notional target. Worth raising as a follow-up: when `rawQty < 1`, consider returning `quantity: 0` with reason "risk per unit exceeds target" instead of clamping to 1.
- Cushion-gate path has no test (thesis flagged this). I confirm: a 3-case stub-broker test is cheap and would catch threshold/severity flips.

### Verdict
APPROVE. Ship after either (a) tightening `direction: string` → `Direction`, or (b) acknowledging it as a follow-up. The naked-short fixes are go-live-critical and correct; the test coverage is real (not theatre); rails are respected. The min-clamp-overshoots-target observation is the only thing I'd want logged as a known issue before live.
