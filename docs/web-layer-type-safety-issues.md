# Web Layer Type Safety Issues

Discovered 2026-03-01 while threading `hasSubsequentMessage` flag through the trades table pipeline.

## 1. Drizzle 1.0-beta query return types are broken

**Severity**: Critical — entire web layer has no compile-time type safety from DB queries.

**Problem**: `drizzle-orm@1.0.0-beta.15` infers `{} | { [x: string]: never; }` for query return types instead of the actual row shape. 306 pre-existing type errors in `web/lib/queries.ts` alone. Functions like `getClosedTrades()`, `getBacktestRunById()`, `getTradesByBacktestRun()` all return untyped rows.

**Implications**:
- Schema changes (add/rename/remove column) produce zero compile-time errors in consumers
- Accessing `trade.nonExistentField` compiles without warning
- Only caught at runtime when the field is actually used in UI rendering
- `getTableColumns()` spread into `.select()` also fails type inference — required a `SAFETY` cast for `getOpenTrades()` computed column
- Every `tsc --noEmit` run produces 300+ noise errors, making it impossible to catch real regressions

**Fix**: Pin `drizzle-orm@0.44.7` (last stable pre-1.0). One line in `package.json`. The Drizzle team themselves recommend this as the escape hatch for beta breakage. The 300+ type errors go away, `getTableColumns()` spread works, `SAFETY` cast on `getOpenTrades()` can be removed. Revisit when 1.0 stable ships.

If staying on beta for some reason, the fallback is `drizzle-orm/zod` (`createSelectSchema(table)` + `.parse()` on query results) for runtime safety. But that's adding code to compensate for broken inference — pinning avoids it entirely.

**Key files**: `package.json`, `web/lib/queries.ts`, `web/lib/db.ts`

## 2. `startingEquity` is optional with a silent 100k fallback

**Severity**: High — wrong P&L concentration percentages for any non-100k account.

**Problem**: `startingEquity` is `number | undefined` in the backtest config schema. The single call site in `web/app/backtests/[id]/page.tsx` falls back via `config.startingEquity ?? 100_000`. Then it flows as `number | null` through the Zustand store. `TradeRow` guards with a ternary to compute notional concentration %.

**Implications**:
- A backtest with $50k starting equity silently shows concentration percentages at half their true value
- A backtest with $200k shows double — positions appear safer than they are
- No warning or indicator that the fallback was used
- The 100k magic number is defined in exactly one JSX prop, not in a config constant

**Fix**: Delete `.optional()` from `startingEquity` in the backtest config Zod schema. Existing `.parse()` calls at backtest creation will enforce it automatically — no new validation code. Then delete the `?? 100_000` fallback (dead code). Net negative lines.

**Key files**: Backtest config schema (likely `src/backtest/` or `src/db/schema.ts`), `web/app/backtests/[id]/page.tsx:207`

## 3. `commissionSchedule` silently falls back to zero commission

**Severity**: Medium — P&L column shows gross instead of net with no indication.

**Problem**: `commissionSchedule` is optional through the entire pipeline: optional in `TradesHydration`, `CommissionSchedule | null` in the store, guarded with a ternary in `TradeRow` (`commissionSchedule ? computeTradeCommission(...) : 0`). When missing, all trades show gross P&L as if commission is zero.

**Implications**:
- Users see inflated P&L numbers without knowing commission wasn't applied
- Win rate can appear higher (trades that are losers net-of-commission show as winners)
- No visual indicator distinguishing "gross P&L" from "net P&L" in the UI
- Backtest runs without a commission schedule look unrealistically profitable

**Fix**: Same as `startingEquity` — delete `.optional()` from `commissionSchedule` in the config schema. For live trades, default to the broker's actual schedule (IBKR has known rates). The "no commission" case should be explicit `{ perContract: 0, perShare: 0 }`, not absence. The `?? null` fallbacks and ternary guards in the store/TradeRow become dead code to delete.

**Key files**: `web/stores/trades-store.ts`, `web/app/components/trade-row.tsx:114-115`, backtest config schema

## 4. Two separate trade views with duplicated flag logic

**Severity**: Low — maintenance burden, not a correctness issue today.

**Problem**: Open trades render as a card grid (`web/app/trades/open/page.tsx`) with its own inline SQL computed column for `hasSubsequentMessage`. Closed trades use the `TradesTableClient` + Zustand store + flag system (`trade-row.tsx`, `trade-filters.tsx`). The "has update" flag now exists in both places with different implementations:
- Card page: correlated `EXISTS` subquery in the `SELECT` clause, rendered as an inline amber chip
- Table: batch query `getTradesWithSubsequentMessages()` -> store -> `FlagChip` component

**Implications**:
- Adding a new flag requires changes in two places
- Styling/behavior can drift between the two views
- Open trades don't benefit from the filter system (no `TradeFilterProvider`)
- If the SQL logic changes, both implementations must be updated

**Fix**: Unify to a single `TradesTableClient` view for both open and closed trades, with a status filter toggle. Or accept the split and extract the SQL expression into a shared constant.

**Key files**: `web/app/trades/open/page.tsx`, `web/app/components/trade-row.tsx`, `web/lib/queries.ts`

## 5. SQLite boolean expressions return 0/1, typed as `boolean`

**Severity**: Low — works with truthiness checks, fails strict equality.

**Problem**: `sql<boolean>\`EXISTS (...)\`` annotates the return type as `boolean`, but SQLite returns `0`/`1` integers. The `sql<T>` generic is a TS-only annotation that doesn't transform the runtime value.

**Implications**:
- `row.hasSubsequentMessage === true` fails (it's `1`, not `true`)
- `{row.hasSubsequentMessage && <Component />}` renders `0` as visible text if not guarded
- `if (row.hasSubsequentMessage)` works correctly (truthiness)

**Fix**: Use `!!` at the consumption site. One character per usage. The only real landmine is JSX `&&` rendering — change to `{!!val && <X />}` or `{val ? <X /> : null}`. No wrapper functions, no `.mapWith()` needed.

**Key files**: `web/lib/queries.ts` (any `sql<boolean>` usage), `web/app/trades/open/page.tsx`
