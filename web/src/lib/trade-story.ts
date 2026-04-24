import type {
  Message,
  MessageIntent,
  ReconciliationAlert,
  RunDecision,
  Task,
  Trade,
  TradeEvent,
} from '@src/db/schema';

export type LivePosition = {
  unrealizedPnl: number;
  marketValue: number | null;
};

/**
 * Unified story returned by both /trades/:id/story and /tasks/:id.
 * `trade` is null when the signal was skipped, failed, or is still pending.
 */
export type TradeStory = {
  trade: Trade | null;
  events: TradeEvent[];
  task: Task | null;
  sourceMessage: Message | null;
  closeMessage: Message | null;
  nearbyMessages: Message[];
  decision: RunDecision | null;
  decisions: RunDecision[];
  timelineMessages: Message[];
  subsequentMessages: Message[];
  intent: MessageIntent | null;
  reconAlerts: ReconciliationAlert[];
  livePosition: LivePosition | null;
};
