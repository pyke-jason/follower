'use server';

import { db, schema } from '@/lib/db';
import type { TradeLeg, Trade, TradeEvent, Task, Message, TaskContext, RunDecision } from '@db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import {
  getTradeById,
  getTradeEvents,
  getTaskById,
  getMessagesByAuthorAndSymbol,
  getMessageById,
  getMessagesByIds,
  getRunDecisionForTask,
  getDecisionsForTrade,
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

export type TradeStoryDecision = {
  outcome: string | null;
  reasoning: string | null;
  phase: string | null;
  durationMs: number | null;
  pnl: string | null;
};

export type TimelineMessage = {
  id: string;
  cleanText: string;
  author: string;
  timestamp: string;
};

export type TradeStory = {
  trade: Trade;
  events: TradeEvent[];
  task: Task | null;
  taskContext: TaskContext | null;
  sourceMessage: Message | null;
  closeMessage: Message | null;
  nearbyMessages: Message[];
  decision: TradeStoryDecision | null;
  decisions: RunDecision[];
  timelineMessages: TimelineMessage[];
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
    sourceMessage && trade.symbol
      ? getMessagesByAuthorAndSymbol(sourceMessage.author, trade.symbol)
      : Promise.resolve([]),
    trade.sourceMessageId
      ? getRunDecisionForTask(trade.sourceMessageId, {
          backtestRunId: runId,
          taskId: !runId && trade.taskId ? trade.taskId : undefined,
        })
      : Promise.resolve(null),
  ]);

  // Extract decision from run_decisions (works for both backtest and live)
  let decision: TradeStoryDecision | null = null;
  if (runDecisionRow) {
    decision = {
      outcome: runDecisionRow.outcome,
      reasoning: runDecisionRow.reasoning,
      phase: runDecisionRow.phase,
      durationMs: runDecisionRow.durationMs,
      pnl: runDecisionRow.pnl,
    };
  }

  const taskContext = task?.context ?? null;

  // Fetch full decisions for the execution timeline
  const decisions = await getDecisionsForTrade(trade);
  const knownMessageIds = new Set([trade.sourceMessageId, trade.closeMessageId].filter(Boolean));
  const intermediateIds = [...new Set(decisions.map(d => d.messageId))].filter(id => !knownMessageIds.has(id));
  const intermediateMessages = intermediateIds.length > 0 ? await getMessagesByIds(intermediateIds) : [];

  const timelineMessages: TimelineMessage[] = [sourceMessage, closeMessage, ...intermediateMessages]
    .filter((m): m is NonNullable<typeof m> => m != null)
    .map(m => ({ id: m.id, cleanText: m.cleanText, author: m.author, timestamp: m.timestamp }));

  return { trade, events, task, taskContext, sourceMessage, closeMessage, nearbyMessages, decision, decisions, timelineMessages };
}

