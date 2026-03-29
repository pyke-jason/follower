import { useCallback, useState } from 'react';

export type SortState<T extends string> = { column: T; dir: 'asc' | 'desc' };

export function useSort<T extends string>(defaultCol: T, defaultDir: 'asc' | 'desc' = 'desc') {
  const [sort, setSort] = useState<SortState<T>>({ column: defaultCol, dir: defaultDir });

  const toggle = useCallback((column: T) => {
    setSort((prev) => {
      if (prev.column === column) {
        return { column, dir: prev.dir === 'desc' ? 'asc' : 'desc' };
      }
      return { column, dir: 'asc' };
    });
  }, []);

  const toParams = useCallback(
    () => ({ sort: sort.column, dir: sort.dir }),
    [sort],
  );

  return { sort, toggle, toParams };
}
