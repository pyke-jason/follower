# Credit Spread Position Sizing Fix

## Problem

The position sizer used `entryPrice` (net premium) for all strategies. For credit spreads (PCS, CCS), this is wrong — the premium is what you RECEIVE, not what you risk. Actual capital at risk = `strikeWidth - premium`.

Example: PCS sell 260P / buy 255P, midpoint $1.20 credit.
- Strike width: $5. Max loss per contract: ($5 - $1.20) x 100 = $380.
- Old sizer (uses entryPrice $1.20): `floor(5000 / 120) = 41 contracts` — $15,580 at risk.
- Fixed (uses maxRisk $3.80): `floor(5000 / 380) = 13 contracts` — $4,940 at risk.

For debit spreads (CDS, PDS), `entryPrice` IS the risk. No change needed.

## Solution — Sizer Owns Risk Math

The sizer accepts `legs: Leg[]` and internally computes strike width and credit spread risk. The executor just passes `signal.legs` — no inline computation.

### position-sizing/index.ts

- `getStrikeWidth(legs)` — extracts strikes from option legs, returns width if exactly 2 legs
- `riskPerUnit(strategy, entryPrice, legs)` — returns `{ value, detail? }`:
  - Credit (PCS/CCS): `Math.max(0.01, width - entryPrice)` with detail string
  - Everything else: `entryPrice`
- `calculateNotionalSize()` uses `riskPerUnit()` for sizing and reasoning

### execute-resolved.ts

OPEN path passes `legs: signal.legs` to `calculatePositionSize()`. No inline risk computation.

### build-deps.ts

Factory passthrough: `legs: input.legs`.

## Files Modified

| File | Change |
|------|--------|
| `src/position-sizing/index.ts` | Accept `legs: Leg[]`, compute strike width + risk internally |
| `src/pipeline/execute-resolved.ts` | Pass `legs: signal.legs` to sizer (removed dead `spreadMaxRisk`) |
| `src/pipeline/build-deps.ts` | Forward `legs: input.legs` |
| `src/position-sizing/index.test.ts` | 8 unit tests (credit/debit/naked/stock/caps/reasoning) |
| `src/pipeline/build-deps.test.ts` | Integration test: credit vs debit sizing with MAX_CONTRACTS cap |

## Edge Cases

| Case | Handling |
|------|----------|
| `strikeWidth <= entryPrice` | `Math.max(0.01, width - entryPrice)` floors to $0.01 |
| Non-2-leg spreads (iron condors) | `getStrikeWidth` returns undefined → falls back to `entryPrice` |
| CCS strategy (no parser regex) | If it reaches executor via LLM path, sizing fix applies correctly |
| MAX_CONTRACTS cap | CDS capped at 20 (from `risk-defaults.ts`), PCS/CCS not capped |

## Status: COMPLETE

All 9 tests pass (8 sizer unit + 1 integration).
