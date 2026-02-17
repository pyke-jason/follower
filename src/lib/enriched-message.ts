import type { Message } from '../db/schema.js';

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

/** Agent decision for a message — from runDecisions (backtest) or task.result (live). */
export type MessageDecision = {
  decision: 'EXECUTE' | 'SKIP';
  reasoning: string | null;
  pnl: string | null;
  path: string;
  durationMs: number | null;
};

/** A chat message enriched with its trade outcome and agent decision. */
export type EnrichedMessage = {
  message: Message;
  trade: TradeOutcome | null;
  decision: MessageDecision | null;
};

export type MessageRole = 'executed' | 'skipped' | 'noise';

export function getMessageRole(em: EnrichedMessage): MessageRole {
  if (em.trade) return 'executed';
  if (em.decision) return 'skipped';
  return 'noise';
}
