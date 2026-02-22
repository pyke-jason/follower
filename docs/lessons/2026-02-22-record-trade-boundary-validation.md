Problem
recordTrade() had a dozen inline throws and ?? fallbacks scattered through its orchestration logic,
violating the project rule: "validate at the boundary, not in orchestration."  exitPrice null checks
appeared 3 times (CLOSE/TRIM/LEG_OFF), direction/strategy were checked once at the top but wrongly
for all actions (CLOSE doesn't need them from input — they come from the existing trade).  quantity ?? 1
and legs ?? [] masked potential bugs where position sizing should always provide these values.
The force-exit endpoint swallowed broker failures as JSON 500 with no alerting.  LEG_OFF extracted
targetStrategy/keptLeg from metadata via double casts (as Record<string, unknown>).targetStrategy as string).

Decision
Created a Zod discriminated union (z.union of per-action schemas) for RecordTradeInput and parse at
the top of recordTrade().  Each action variant declares exactly which fields are required:
  OPEN: direction, strategy, quantity, legs all required (not optional with fallbacks)
  CLOSE/TRIM/LEG_OFF: exitPrice required (zNonNegPrice); direction/strategy optional (only for scope filter)
  ADD: direction, strategy, quantity required
  LEG_OFF: targetStrategy, keptLeg promoted to named required fields (not metadata)
Backtest timestamp requirements handled via .refine() on the per-action schemas.
Force-exit endpoint now validates body with Zod, sends system alert on failure, checks order status
instead of filledPrice nullability.  EOD sweep dedup changed from N+1 json_extract queries to a
single batch load of existing review tasks.

Key Files
  src/trades/record-trade.ts — Zod schemas + parse at boundary, inline throws removed
  src/pipeline/execute.ts — LEG_OFF caller passes targetStrategy/keptLeg as named fields
  src/backtest/sim-broker.ts — closePositionAtPrice passes direction/strategy from trade row
  src/local-api/routes/trades.ts — Zod body validation, sendSystemAlert, status check
  src/orders/eod-sweep.ts — batch dedup instead of N+1

Watch Out
The z.union() approach (not z.discriminatedUnion()) is used because .refine() on individual schemas
returns ZodEffects which can't be used in z.discriminatedUnion().  This means Zod tries each variant
in order on parse failure — error messages may be less specific than a true discriminated union.
If TS narrowing after RecordTradeInputSchema.parse() doesn't work well in practice, consider
splitting recordTrade() into per-action functions that each receive their narrowed type.
