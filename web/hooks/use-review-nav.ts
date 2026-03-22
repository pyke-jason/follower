import { useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * URL-driven navigation state for the discrepancy review queue.
 *
 * Stores active item ID, category filter, and reviewed filter in query params
 * so the review position survives refresh and can be shared.
 */
export function useReviewNav<T extends { id: string }>(items: T[]) {
  const [params, setParams] = useSearchParams();

  const activeId = params.get('id');
  const category = params.get('cat') ?? '';
  const showReviewed = params.get('reviewed') === 'true';

  const currentIdx = useMemo(() => {
    if (!activeId || items.length === 0) return 0;
    const idx = items.findIndex(r => r.id === activeId);
    return idx >= 0 ? idx : 0;
  }, [activeId, items]);

  const current = items[currentIdx] ?? null;

  const goTo = useCallback((id: string) => {
    setParams(p => { p.set('id', id); return p; }, { replace: true });
  }, [setParams]);

  const go = useCallback((delta: number) => {
    const nextIdx = Math.max(0, Math.min(currentIdx + delta, items.length - 1));
    const next = items[nextIdx];
    if (next) goTo(next.id);
  }, [currentIdx, items, goTo]);

  const setCategory = useCallback((cat: string) => {
    setParams(p => {
      if (cat) p.set('cat', cat); else p.delete('cat');
      p.delete('id');
      return p;
    }, { replace: true });
  }, [setParams]);

  const setShowReviewed = useCallback((show: boolean) => {
    setParams(p => {
      if (show) p.set('reviewed', 'true'); else p.delete('reviewed');
      p.delete('id');
      return p;
    }, { replace: true });
  }, [setParams]);

  return {
    current,
    currentIdx,
    category,
    showReviewed,
    go,
    goTo,
    setCategory,
    setShowReviewed,
    total: items.length,
  };
}
