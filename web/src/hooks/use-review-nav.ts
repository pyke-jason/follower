import { useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useReviewFilters } from './use-review-filters';

/**
 * URL-driven navigation for the review queue.
 * Composes useReviewFilters (filter state) with item-based navigation.
 */
export function useReviewNav<T extends { id: string }>(items: T[]) {
  const filters = useReviewFilters();
  const [params, setParams] = useSearchParams();

  const activeId = params.get('id');

  const currentIdx = useMemo(() => {
    if (!activeId || items.length === 0) return 0;
    const idx = items.findIndex(r => r.id === activeId);
    return idx >= 0 ? idx : 0;
  }, [activeId, items]);

  const current = items[currentIdx] ?? null;

  const goTo = useCallback((id: string) => {
    setParams(p => { if (id) p.set('id', id); else p.delete('id'); return p; }, { replace: true });
  }, [setParams]);

  const go = useCallback((delta: number) => {
    const nextIdx = Math.max(0, Math.min(currentIdx + delta, items.length - 1));
    const next = items[nextIdx];
    if (next) goTo(next.id);
  }, [currentIdx, items, goTo]);

  return {
    ...filters,
    current,
    currentIdx,
    go,
    goTo,
    total: items.length,
  };
}
