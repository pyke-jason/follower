import type { OrderStatus, WorkingOrder, WorkingOrderParams } from '../broker/types.js';
import type { PendingResumeData } from '../pipeline/execute-resolved.js';

export type BacktestRunStatsSnapshot = {
  agentTrades: number;
  skipped: number;
  skipReasons: Record<string, number>;
  failedEntrySignals: number;
  failedExitSignals: number;
  expiredWithoutSignal: number;
};

export type SerializedWorkingOrder = Omit<
  WorkingOrder,
  'placedAt' | 'lastAdjustedAt' | 'filledAt' | 'cancelledAt'
> & {
  placedAt: string;
  lastAdjustedAt: string;
  filledAt?: string;
  cancelledAt?: string;
};

export type SerializedSimBrokerWorkingOrder = {
  params: WorkingOrderParams;
  currentLimitPrice: number;
  status: OrderStatus;
  filledPrice?: number;
  isOptionOrder: boolean;
};

export type SerializedSimBrokerState = {
  orderCounter: number;
  workingOrders: Array<[string, SerializedSimBrokerWorkingOrder]>;
  filledOrders: Array<[string, { price: number; timestamp: string }]>;
  lastAdvanceTime: string | null;
};

export type BacktestPendingIntentSnapshot = {
  orderId: string;
  context: PendingResumeData;
};

export type BacktestCheckpointState = {
  version: 1;
  runId: string;
  channelId: string;
  phase: 'REPLAYING' | 'FINALIZING' | 'COMPLETED';
  nextIndex: number;
  lastCompletedIndex: number;
  lastCompletedMessageId: string | null;
  lastCompletedMessageTs: string | null;
  lastMsgDay: string;
  clockTime: string;
  lastMtmTime: number;
  lastMtmValue: number | null;
  lastOpenCount: number;
  stats: BacktestRunStatsSnapshot;
  shadowKeys: string[];
  broker: SerializedSimBrokerState;
  orderManager: SerializedWorkingOrder[];
  pendingIntents: BacktestPendingIntentSnapshot[];
  updatedAt: string;
};
