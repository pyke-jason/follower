---
paths: src/db/**, src/trades/**
---

# Database & Trade Recording

## Single Write Path

`recordTrade()` in `src/trades/record-trade.ts` is the **only** way to mutate trade data. It handles OPEN, CLOSE, ADD, TRIM, and LEG_OFF actions. It writes to both `trade_events` (append-only source of truth) and `trades` (denormalized view).

Never write directly to `trades` or `trade_events` tables outside of `recordTrade()`.

## JSON Column Accessors

Drizzle's `$type<>()` does NOT propagate through `select()`. For every JSON column, create a typed accessor in `src/db/accessors.ts`:

```ts
export function getLegs(row: { legs: unknown }): TradeLeg[] { ... }
export function getConfig(row: { config: unknown }): BacktestConfig { ... }
```

Cast/parse happens **once** inside the accessor. Call sites never cast. If you find yourself writing `as TradeLeg[]` at a call site, you're missing an accessor.

## Composable Filters (filters.ts)

`src/trades/filters.ts` exports composable Drizzle query fragments: `isOpen`, `isClosed`, `notBacktest`, `forRun()`, `forSymbol()`, `forTrader()`, `forStrategy()`.

Filters import from `db/schema` only (not `db/client`) for web compatibility. The web frontend imports these filters directly.

## Schema (schema.ts)

This is the source of truth for all table definitions. When changing the schema:
1. Update `schema.ts`
2. Run `npm run db:generate` to create a migration
3. Run `npm run db:migrate` to apply it
4. Update any affected accessors in `accessors.ts`
5. Update any affected types that derive from the schema

## computeCoreStats

`computeCoreStats()` is the single source of truth for trade statistics (win rate, P&L, drawdown, etc.). Used by both backtest reports and the web dashboard. Don't compute stats independently — use this function.
