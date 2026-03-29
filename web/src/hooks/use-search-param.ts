import { useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';

/**
 * Returns the current value of a search param and a setter that does
 * a replace-navigation (no history entry) to update it.
 * Passing `null` or the `defaultValue` removes the param from the URL.
 */
export function useSearchParam(key: string, defaultValue?: string) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const value = searchParams.get(key) ?? defaultValue ?? null;

  const setValue = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next == null || next === defaultValue) {
        params.delete(key);
      } else {
        params.set(key, next);
      }
      navigate(`?${params.toString()}`, { replace: true });
    },
    [key, defaultValue, navigate, searchParams],
  );

  return [value, setValue] as const;
}
