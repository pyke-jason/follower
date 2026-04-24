import type { Message } from '../db/schema.js';
import type { Signal } from '../agent/schemas.js';

/** Subset of Trade fields needed for inline display in the chat feed. */
export type TradeOutcome = {
  id: string;
  symbol: string;
  direction: string;
  strategy: string;
  entryPrice: string | null;
  exitPrice: string | null;
  pnl: string | null;
  status: string;
  quantity: number | null;
  openedAt: string | null;
  closedAt: string | null;
};

/** Agent decision for a message — from runDecisions (backtest and live). */
export type MessageDecision = {
  outcome: 'EXECUTE' | 'SKIP' | 'FAIL' | 'PENDING';
  reasoning: string | null;
  pnl: string | null;
  phase: string;
  durationMs: number | null;
  taskId: string | null;
};

/** Latest classifier/orchestrator intent for a message, before execution settles. */
export type MessageIntentSummary = {
  decision: 'EXECUTE' | 'SKIP' | 'MANUAL_REVIEW';
  route: string;
  reasoning: string | null;
  signals: Signal[] | null;
  durationMs: number | null;
  model: string;
  version: number;
};

/** A chat message enriched with its trade outcome and agent decision. */
export type EnrichedMessage = {
  message: Message;
  trade: TradeOutcome | null;
  decision: MessageDecision | null;
  intent: MessageIntentSummary | null;
};
