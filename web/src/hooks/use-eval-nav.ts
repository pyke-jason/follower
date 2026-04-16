import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Manages selected-item navigation through a list of eval label rows.
 * Uses `id` search param for the selected item — this is navigation state, not filter state.
 */
export function useEvalNav<T extends { id: string; humanVerified: boolean }>(items: T[]) {
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

  /** Jump to the next unreviewed item after the current index. Wraps around. Falls back to sequential +1. */
  const goNextUnreviewed = useCallback(() => {
    // Search forward from currentIdx
    for (let i = currentIdx + 1; i < items.length; i++) {
      if (!items[i].humanVerified) {
        goTo(items[i].id);
        return;
      }
    }
    // Wrap around from start
    for (let i = 0; i < currentIdx; i++) {
      if (!items[i].humanVerified) {
        goTo(items[i].id);
        return;
      }
    }
    // All reviewed: fall back to next sequential
    const nextIdx = Math.min(currentIdx + 1, items.length - 1);
    const next = items[nextIdx];
    if (next) goTo(next.id);
  }, [currentIdx, items, goTo]);

  return { current, currentIdx, go, goTo, goNextUnreviewed, total: items.length };
}
