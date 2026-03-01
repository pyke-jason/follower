import { create } from 'zustand';

export interface RunBrief {
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
  openTrades: number;
  todayPnl: number;
  pendingTasks: number;
  tradingBlocked?: boolean;
  unresolvedAlertCount?: number;
  runBrief?: RunBrief;
}

interface RunState {
  runId: string | null;
  status: StatusData | null;
  runBrief: RunBrief | null;

  setRunId: (id: string | null) => void;
  refreshStatus: () => void;
  startPolling: () => void;
  stopPolling: () => void;
  selectRun: (id: string | null) => void;
}

// Module-level internals kept out of zustand state to avoid spurious re-renders
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _selectRunImpl: (id: string | null) => void = () => {};

export function setSelectRunImpl(fn: (id: string | null) => void) {
  _selectRunImpl = fn;
}

export const useRunStore = create<RunState>((set, get) => ({
  runId: null,
  status: null,
  runBrief: null,

  setRunId: (id) => set({ runId: id }),

  refreshStatus: () => {
    const { runId } = get();
    const url = runId ? `/api/status?run=${runId}` : '/api/status';
    fetch(url)
      .then((r) => r.json())
      .then((status: StatusData) =>
        set({ status, runBrief: status.runBrief ?? null }),
      )
      .catch(() => {});
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

  selectRun: (id) => _selectRunImpl(id),
}));
