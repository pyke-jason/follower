import { create } from 'zustand';
import type { Trade, TradeEvent, TradeFlag, CommissionSchedule, Task, Message, RunDecision } from '@src/db/schema';
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
  commissionSchedule?: CommissionSchedule;
  startingEquity?: number;
  channelId?: string;
};

interface TradesState {
  trades: Trade[];
  eventsByTradeId: Record<string, TradeEvent[]>;
  flagsByTradeId: Record<string, TradeFlag[]>;
  commissionSchedule: CommissionSchedule | undefined;
  startingEquity: number | undefined;
  channelId: string | undefined;

  selectedTradeId: string | null;
  story: TradeStory | null;
  isLoadingStory: boolean;

  hydrate: (data: TradesHydration) => void;
  selectTrade: (id: string | null) => void;
  loadTradeStory: (tradeId: string) => Promise<void>;
}

export const useTradesStore = create<TradesState>((set, get) => ({
  trades: [],
  eventsByTradeId: {},
  flagsByTradeId: {},
  commissionSchedule: undefined,
  startingEquity: undefined,
  channelId: undefined,

  selectedTradeId: null,
  story: null,
  isLoadingStory: false,

  hydrate: (data) =>
    set({
      trades: data.trades,
      eventsByTradeId: data.eventsByTradeId,
      flagsByTradeId: data.flagsByTradeId,
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
}));
