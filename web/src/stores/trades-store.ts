import { create } from 'zustand';
import type { Trade, TradeEvent, TradeFlag, CommissionSchedule, Task, Message, RunDecision } from '@src/db/schema';
import type { TradeLabel } from '@/lib/api-types';
import { api } from '@/lib/api';

export type TradeStory = {
  trade: Trade;
  events: TradeEvent[];
  task: Task | null;
  sourceMessage: Message | null;
  closeMessage: Message | null;
  nearbyMessages: Message[];
  decision: RunDecision | null;
  decisions: RunDecision[];
  timelineMessages: Message[];
};

export type TradesHydration = {
  trades: Trade[];
  eventsByTradeId: Record<string, TradeEvent[]>;
  flagsByTradeId: Record<string, TradeFlag[]>;
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

  unrealizedPnl: Record<string, number>;

  selectedTradeId: string | null;
  story: TradeStory | null;
  isLoadingStory: boolean;

  hydrate: (data: TradesHydration) => void;
  selectTrade: (id: string | null) => void;
  loadTradeStory: (tradeId: string) => Promise<void>;
  setUnrealizedPnl: (pnl: Record<string, number>) => void;
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

  unrealizedPnl: {},

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

  setUnrealizedPnl: (pnl) => set({ unrealizedPnl: pnl }),

  updateLabel: (tradeId, patch) => set((state) => ({
    labelsByTradeId: {
      ...state.labelsByTradeId,
      [tradeId]: { ...state.labelsByTradeId[tradeId], ...patch },
    },
  })),
}));
