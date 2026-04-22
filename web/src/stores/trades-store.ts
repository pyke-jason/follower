import { create } from 'zustand';
import type { Trade, TradeEvent, TradeFlag, CommissionSchedule, Task, Message, RunDecision, MessageIntent, ReconciliationAlert } from '@src/db/schema';
import type { TradeLabel } from '@src/local-api/http-schemas';
import { api } from '@/lib/api';

export type LivePosition = {
  unrealizedPnl: number;
  marketValue: number | null;
};

/**
 * Unified story returned by both /trades/:id/story and /tasks/:id.
 * `trade` is null when the signal was skipped, failed, or is still pending —
 * the rest of the shape still carries the realized outcome, decisions, and
 * trader context, so one UI template handles every case.
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

export type TradesHydration = {
  trades: Trade[];
  eventsByTradeId: Record<string, TradeEvent[]>;
  flagsByTradeId: Record<string, TradeFlag[]>;
  livePositionsByTradeId?: Record<string, LivePosition>;
  labelsByTradeId?: Record<string, TradeLabel>;
  commissionSchedule?: CommissionSchedule;
  startingEquity?: number;
  channelId?: string;
};

interface TradesState {
  trades: Trade[];
  eventsByTradeId: Record<string, TradeEvent[]>;
  flagsByTradeId: Record<string, TradeFlag[]>;
  labelsByTradeId: Record<string, TradeLabel>;
  commissionSchedule: CommissionSchedule | undefined;
  startingEquity: number | undefined;
  channelId: string | undefined;

  livePositionsByTradeId: Record<string, LivePosition>;

  selectedTradeId: string | null;
  story: TradeStory | null;
  isLoadingStory: boolean;

  hydrate: (data: TradesHydration) => void;
  selectTrade: (id: string | null) => void;
  loadTradeStory: (tradeId: string) => Promise<void>;
  updateLabel: (tradeId: string, patch: Partial<TradeLabel>) => void;
}

export const useTradesStore = create<TradesState>((set, get) => ({
  trades: [],
  eventsByTradeId: {},
  flagsByTradeId: {},
  labelsByTradeId: {},
  commissionSchedule: undefined,
  startingEquity: undefined,
  channelId: undefined,

  livePositionsByTradeId: {},

  selectedTradeId: null,
  story: null,
  isLoadingStory: false,

  hydrate: (data) =>
    set({
      trades: data.trades,
      eventsByTradeId: data.eventsByTradeId,
      flagsByTradeId: data.flagsByTradeId,
      labelsByTradeId: data.labelsByTradeId ?? {},
      commissionSchedule: data.commissionSchedule,
      startingEquity: data.startingEquity,
      channelId: data.channelId,
      livePositionsByTradeId: data.livePositionsByTradeId ?? {},
    }),

  selectTrade: (id) => {
    if (id === get().selectedTradeId) return;
    set({ selectedTradeId: id, story: null, isLoadingStory: !!id });
    if (id) get().loadTradeStory(id);
  },

  loadTradeStory: async (tradeId) => {
    const channelId = get().channelId;
    const params = channelId ? `?channel=${channelId}` : '';
    const result = await api<TradeStory>(`/trades/${tradeId}/story${params}`);
    if (get().selectedTradeId === tradeId) {
      set({ story: result, isLoadingStory: false });
    }
  },

  updateLabel: (tradeId, patch) => set((state) => ({
    labelsByTradeId: {
      ...state.labelsByTradeId,
      [tradeId]: { ...state.labelsByTradeId[tradeId], ...patch },
    },
  })),
}));
