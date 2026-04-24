# Algorithmic Trade Quality

## Problem

Dashboard performance views showed P&L and risk state, but not whether closed trades were good on a risk-adjusted basis. R-multiple and quality grades were missing, and adding manual grading would create a separate feedback workflow instead of deriving signal from existing trade data.

## Decision

Compute finite risk from trade structure and persist lifecycle-aware risk snapshots in `trade.metadata.risk`. Derive quality grades algorithmically from R-multiple, execution friction, process flags, and sizing versus median finite risk. Keep manual overrides, manual grading, and feedback datasets out of scope.

## Key Files

- `src/trades/trade-risk.ts`
- `src/trades/trade-quality.ts`
- `src/trades/record-trade.ts`
- `src/local-api/routes/web-queries.ts`
- `web/src/views/dashboard/quality-snapshot-panel.tsx`

## Watch Out

Stock trades and unbounded short/naked option trades should not get fake R values. Quality analytics read persisted `metadata.risk` only; older rows without that snapshot stay excluded rather than relying on a permanent inference/backfill utility.
