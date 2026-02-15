'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function AutoRefresh({ intervalMs = 2000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (typeof document === 'undefined') return;

    let id: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (!id) id = setInterval(() => router.refresh(), intervalMs);
    }
    function stop() {
      if (id) { clearInterval(id); id = null; }
    }

    if (!document.hidden) start();

    function onVisibility() {
      if (document.hidden) { stop(); } else { router.refresh(); start(); }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, intervalMs]);
  return null;
}
