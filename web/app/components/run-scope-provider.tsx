'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { useSearchParams, usePathname, useRouter } from 'next/navigation';
import { isRunScopedPath } from '@/lib/run-scope';

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

interface RunScopeContextValue {
  runId: string | null;
  status: StatusData | null;
  runBrief: RunBrief | null;
  selectRun: (id: string | null) => void;
}

const RunScopeContext = createContext<RunScopeContextValue | null>(null);

export function useRunScope(): RunScopeContextValue {
  const ctx = useContext(RunScopeContext);
  if (!ctx) throw new Error('useRunScope must be used within <RunScopeProvider>');
  return ctx;
}

export function RunScopeProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const runId = searchParams.get('run');

  const [status, setStatus] = useState<StatusData | null>(null);

  const fetchStatus = useCallback(() => {
    const url = runId ? `/api/status?run=${runId}` : '/api/status';
    fetch(url)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, [runId]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5_000);
    const onFocus = () => fetchStatus();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchStatus]);

  const selectRun = useCallback(
    (id: string | null) => {
      if (id === null) {
        const params = new URLSearchParams(searchParams.toString());
        params.delete('run');
        const qs = params.toString();
        router.push(qs ? `${pathname}?${qs}` : pathname);
        return;
      }
      const target = isRunScopedPath(pathname) ? pathname : '/';
      const params = new URLSearchParams(searchParams.toString());
      params.set('run', id);
      router.push(`${target}?${params.toString()}`);
    },
    [pathname, searchParams, router],
  );

  const runBrief = status?.runBrief ?? null;

  return (
    <RunScopeContext.Provider value={{ runId, status, runBrief, selectRun }}>
      {children}
    </RunScopeContext.Provider>
  );
}
