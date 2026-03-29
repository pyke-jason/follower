import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * URL-driven filter state for the eval review page.
 * Reads/writes category, reviewed, sort, and date range params.
 * Composed by useReviewNav — use directly only when you need
 * filter values before items are available (e.g. query keys).
 */
export function useReviewFilters() {
  const [params, setParams] = useSearchParams();

  const category = params.get('cat') ?? '';
  const showReviewed = params.get('reviewed') === 'true';
  const sortDir = (params.get('dir') ?? 'asc') as 'asc' | 'desc';
  const startDate = params.get('start') ?? '';
  const endDate = params.get('end') ?? '';

  const updateParam = useCallback((key: string, value: string | null) => {
    setParams(p => {
      if (value) p.set(key, value); else p.delete(key);
      p.delete('id');
      return p;
    }, { replace: true });
  }, [setParams]);

  const setDateRange = useCallback((start: string, end: string) => {
    setParams(p => {
      if (start) p.set('start', start); else p.delete('start');
      if (end) p.set('end', end); else p.delete('end');
      p.delete('id');
      return p;
    }, { replace: true });
  }, [setParams]);

  return {
    category,
    showReviewed,
    sortDir,
    startDate,
    endDate,
    setCategory: useCallback((cat: string) => updateParam('cat', cat || null), [updateParam]),
    setShowReviewed: useCallback((show: boolean) => updateParam('reviewed', show ? 'true' : null), [updateParam]),
    setSortDir: useCallback((dir: 'asc' | 'desc') => updateParam('dir', dir === 'asc' ? null : dir), [updateParam]),
    setDateRange,
  };
}
