'use client';

import { useEffect, useCallback, type ReactNode } from 'react';
import { useSearchParams, usePathname, useRouter } from 'next/navigation';
import { useRunStore, setSelectRunImpl } from '@/stores/run-store';
import { isRunScopedPath } from '@/lib/run-scope';

export type { RunBrief, StatusData } from '@/stores/run-store';

/** @deprecated Use useRunStore selectors directly */
export function useRunScope() {
  const runId = useRunStore((s) => s.runId);
  const status = useRunStore((s) => s.status);
  const runBrief = useRunStore((s) => s.runBrief);
  const selectRun = useRunStore((s) => s.selectRun);
  return { runId, status, runBrief, selectRun };
}

export function RunScopeProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const runId = searchParams.get('run');

  const setRunId = useRunStore((s) => s.setRunId);
  const startPolling = useRunStore((s) => s.startPolling);
  const stopPolling = useRunStore((s) => s.stopPolling);
  const refreshStatus = useRunStore((s) => s.refreshStatus);

  // Sync URL → store
  useEffect(() => {
    setRunId(runId);
  }, [runId, setRunId]);

  // Inject selectRun implementation (needs router/pathname/searchParams)
  const selectRunImpl = useCallback(
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

  useEffect(() => {
    setSelectRunImpl(selectRunImpl);
  }, [selectRunImpl]);

  // Polling lifecycle
  useEffect(() => {
    startPolling();
    const onFocus = () => refreshStatus();
    window.addEventListener('focus', onFocus);
    return () => {
      stopPolling();
      window.removeEventListener('focus', onFocus);
    };
  }, [runId, startPolling, stopPolling, refreshStatus]);

  return <>{children}</>;
}
