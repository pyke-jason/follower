/**
 * Composable Drizzle filter fragments for the trades table.
 * Use with `and()` to build queries:
 *
 *   db.select().from(trades).where(and(isOpen, forRun(runId), forSymbol('AAPL')))
 */
import { eq, inArray } from 'drizzle-orm';
import { schema } from '../db/client.js';

export const isOpen = inArray(schema.trades.status, ['OPEN', 'PARTIAL']);
export const isClosed = eq(schema.trades.status, 'CLOSED');
export const notBacktest = eq(schema.trades.isBacktest, false);

export const forRun = (runId: string) => eq(schema.trades.backtestRunId, runId);
export const forSymbol = (sym: string) => eq(schema.trades.symbol, sym);
export const forTrader = (trader: string) => eq(schema.trades.trader, trader);
export const forTask = (taskId: string) => eq(schema.trades.taskId, taskId);
