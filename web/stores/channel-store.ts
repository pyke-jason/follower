import { create } from 'zustand';
import { api } from '@/lib/api';

export type ChannelKind = 'runtime' | 'backtest' | 'unknown';

export interface ChannelBrief {
  id: string;
  name: string | null;
  status: string;
  traders: string[];
  startDate: string;
  endDate: string;
  agentModel: string;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
}

export interface StatusData {
  channelId: string;
  channelKind: ChannelKind;
  openTrades: number;
  todayPnl: number;
  pendingTasks: number;
  tradingBlocked?: boolean;
  unresolvedAlertCount?: number;
  channelBrief?: ChannelBrief;
  // Runtime health (only present for runtime channels)
  brokerHealthy?: boolean;
  circuitOpen?: boolean;
  lastError?: string | null;
  healthUpdatedAt?: string;
}

interface ChannelState {
  channelId: string | null;
  defaultChannelId: string | null;
  status: StatusData | null;
  statusError: string | null;
  channelBrief: ChannelBrief | undefined;

  setChannelId: (id: string) => void;
  setDefaultChannelId: (id: string) => void;
  refreshStatus: () => void;
  startPolling: () => void;
  stopPolling: () => void;
  selectChannel: (id: string) => void;
}

let _intervalId: ReturnType<typeof setInterval> | null = null;

export const useChannelStore = create<ChannelState>((set, get) => ({
  channelId: null,
  defaultChannelId: null,
  status: null,
  statusError: null,
  channelBrief: undefined,

  setChannelId: (id) => set({ channelId: id }),
  setDefaultChannelId: (id) => set({ defaultChannelId: id }),

  refreshStatus: () => {
    const { channelId } = get();
    if (!channelId) return;
    api<StatusData>(`/status?channel=${encodeURIComponent(channelId)}`)
      .then((status) =>
        set({ status, statusError: null, channelBrief: status.channelBrief }),
      )
      .catch(() => {
        set({ status: null, statusError: 'Status unavailable' });
      });
  },

  startPolling: () => {
    if (_intervalId) clearInterval(_intervalId);
    get().refreshStatus();
    _intervalId = setInterval(() => get().refreshStatus(), 5_000);
  },

  stopPolling: () => {
    if (_intervalId) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
  },

  // Default no-op; overridden by ChannelScopeSync via setState.
  selectChannel: () => {},
}));
