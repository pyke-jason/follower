import { create } from 'zustand';
import type { Trade, TradeEvent, CommissionSchedule } from '@src/db/schema';
import type { TradeStory } from '@/app/trades/actions';
import { fetchTradeStory } from '@/app/trades/actions';

export type TradesHydration = {
  trades: Trade[];
  eventsByTradeId: Map<string, TradeEvent[]>;
  cancelledTradeIds: Set<string>;
  commissionSchedule?: CommissionSchedule;
  startingEquity?: number;
  runId?: string;
};

interface TradesState {
  trades: Trade[];
  eventsByTradeId: Map<string, TradeEvent[]>;
  cancelledTradeIds: Set<string>;
  commissionSchedule: CommissionSchedule | null;
  startingEquity: number | null;
  runId: string | null;

  selectedTradeId: string | null;
  story: TradeStory | null;
  isLoadingStory: boolean;

  hydrate: (data: TradesHydration) => void;
  selectTrade: (id: string | null) => void;
  loadTradeStory: (tradeId: string) => Promise<void>;
}

export const useTradesStore = create<TradesState>((set, get) => ({
  trades: [],
  eventsByTradeId: new Map(),
  cancelledTradeIds: new Set(),
  commissionSchedule: null,
  startingEquity: null,
  runId: null,

  selectedTradeId: null,
  story: null,
  isLoadingStory: false,

  hydrate: (data) =>
    set({
      trades: data.trades,
      eventsByTradeId: data.eventsByTradeId,
      cancelledTradeIds: data.cancelledTradeIds,
      commissionSchedule: data.commissionSchedule ?? null,
      startingEquity: data.startingEquity ?? null,
      runId: data.runId ?? null,
    }),

  selectTrade: (id) => {
    if (id === get().selectedTradeId) return;
    set({ selectedTradeId: id, story: null, isLoadingStory: !!id });
    if (id) get().loadTradeStory(id);
  },

  loadTradeStory: async (tradeId) => {
    const result = await fetchTradeStory(tradeId, get().runId ?? undefined);
    if (get().selectedTradeId === tradeId) {
      set({ story: result, isLoadingStory: false });
    }
  },
}));
