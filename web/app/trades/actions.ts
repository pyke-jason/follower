'use server';

import { db, schema } from '@/lib/db';
import type { TradeLeg, Trade, TradeEvent, Task, Message, TaskContext, TaskResult } from '@db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import {
  getTradeById,
  getTradeEvents,
  getTaskById,
  getNearbyMessages,
  getMessageById,
  getRunDecisionForTask,
} from '@/lib/queries';

const LOCAL_API_URL = process.env.LOCAL_API_URL ?? 'http://localhost:4000';

export async function forceExitTrade(formData: FormData) {
  const tradeId = formData.get('tradeId') as string;
  if (!tradeId) return;

  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId));

  if (!trade || trade.status !== 'OPEN') return;

  const legs = trade.legs;
  const closingLegs = legs.map((leg: TradeLeg) => ({
    ...leg,
    action: leg.action === 'BUY' ? 'SELL' : 'BUY',
  }));

  // The API route handles both the broker order AND the recordTrade call
  // (emits trade_events, updates trades row through the canonical write path).
  const res = await fetch(`${LOCAL_API_URL}/trades/force-exit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tradeId: trade.id,
      symbol: trade.symbol,
      trader: trade.trader,
      strategy: trade.strategy,
      direction: trade.direction,
      legs: closingLegs,
    }),
  });

  if (!res.ok) {
    throw new Error(`Force exit failed: ${res.status} ${await res.text()}`);
  }

  revalidatePath('/trades/open');
  revalidatePath('/trades');
  revalidatePath('/');
}

// ─── Trade Story (expanded row data) ────────────────

export type TradeStory = {
  trade: Trade;
  events: TradeEvent[];
  task: Task | null;
  taskContext: TaskContext | null;
  taskResult: TaskResult | null;
  sourceMessage: Message | null;
  closeMessage: Message | null;
  nearbyMessages: Message[];
  decision: {
    decision: string;
    reasoning: string | null;
    path: string | null;
    durationMs: number | null;
    pnl: string | null;
  } | null;
};

export async function fetchTradeStory(tradeId: string, runId?: string): Promise<TradeStory | null> {
  const trade = await getTradeById(tradeId);
  if (!trade) return null;

  const [events, task, sourceMessage, closeMessage] = await Promise.all([
    getTradeEvents(tradeId),
    trade.taskId ? getTaskById(trade.taskId) : Promise.resolve(null),
    trade.sourceMessageId ? getMessageById(trade.sourceMessageId) : Promise.resolve(null),
    trade.closeMessageId ? getMessageById(trade.closeMessageId) : Promise.resolve(null),
  ]);

  // Fetch nearby messages and run decision in parallel (depend on sourceMessage/trade)
  const [nearbyMessages, runDecisionRow] = await Promise.all([
    sourceMessage ? getNearbyMessages(null, sourceMessage.timestamp, 60) : Promise.resolve([]),
    runId && trade.sourceMessageId ? getRunDecisionForTask(trade.sourceMessageId, runId) : Promise.resolve(null),
  ]);

  // Extract decision from run_decisions (backtest) or task result (live)
  let decision: TradeStory['decision'] = null;
  if (runDecisionRow) {
    decision = {
      decision: runDecisionRow.decision,
      reasoning: runDecisionRow.reasoning,
      path: runDecisionRow.path,
      durationMs: runDecisionRow.durationMs,
      pnl: runDecisionRow.pnl,
    };
  } else if (task?.result) {
    decision = {
      decision: task.result.decision ?? '',
      reasoning: task.result.reasoning ?? null,
      path: null,
      durationMs: null,
      pnl: null,
    };
  }

  const taskContext = task?.context ?? null;
  const taskResult = task?.result ?? null;

  return { trade, events, task, taskContext, taskResult, sourceMessage, closeMessage, nearbyMessages, decision };
}

