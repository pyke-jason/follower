/**
 * Composable Drizzle filter fragments for the trades table.
 * Use with `and()` to build queries:
 *
 *   db.select().from(trades).where(and(isOpen, forChannel(channelId), forSymbol('AAPL')))
 */
import { eq } from 'drizzle-orm';
import { trades } from '../db/schema.js';
import type { Strategy } from '../lib/enums.js';

export const isOpen = eq(trades.status, 'OPEN');
export const isClosed = eq(trades.status, 'CLOSED');

export const forChannel = (channelId: string) => eq(trades.channelId, channelId);
export const forSymbol = (sym: string) => eq(trades.symbol, sym);
export const forTrader = (trader: string) => eq(trades.trader, trader);
export const forStrategy = (strategy: Strategy) => eq(trades.strategy, strategy);
export const forTask = (taskId: string) => eq(trades.taskId, taskId);

export type PositionFilters = { symbol?: string; trader?: string; strategy?: Strategy };
