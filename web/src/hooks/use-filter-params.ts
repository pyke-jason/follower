import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Factory for typed, URL-synced filter + sort hooks.
 *
 * Call once at module level to define a page's filter shape:
 *   const useTradeListParams = createFilterParams({ sort: {...}, trader: {...} });
 *
 * Then use inside components:
 *   const { sort, trader, setSort, setTrader, hasFilters, clearFilters } = useTradeListParams();
 *
 * URL is the source of truth. React Router stays in the loop.
 * Back button works. Views are bookmarkable.
 */

// ── Types ───────────────────────────────────────────────

type SortDir = 'asc' | 'desc';

type ParamDef =
  | { type: 'string'; default?: string }
  | { type: 'boolean'; default?: boolean }
  | { type: 'string[]'; default?: string[] }
  | { type: 'sort'; defaultColumn: string; defaultDir?: SortDir };

type ParamDefs = Record<string, ParamDef>;

type InferValue<D extends ParamDef> =
  D extends { type: 'string' }   ? string :
  D extends { type: 'boolean' }  ? boolean :
  D extends { type: 'string[]' } ? string[] :
  D extends { type: 'sort' }     ? { column: string; dir: SortDir } :
  never;

type InferValues<T extends ParamDefs> = { [K in keyof T]: InferValue<T[K]> };

type SetterFor<D extends ParamDef> =
  D extends { type: 'sort' }
    ? (column: string) => void
    : (value: InferValue<D> | null) => void;

type Setters<T extends ParamDefs> = {
  [K in keyof T as `set${Capitalize<string & K>}`]: SetterFor<T[K]>;
};

type FilterResult<T extends ParamDefs> = InferValues<T> & Setters<T> & {
  hasFilters: boolean;
  clearFilters: () => void;
  /** Serialize current values to a plain Record for API calls */
  toParams: () => Record<string, string>;
};

// ── Helpers ─────────────────────────────────────────────

function read(params: URLSearchParams, key: string, def: ParamDef): unknown {
  switch (def.type) {
    case 'string':   return params.get(key) ?? def.default ?? '';
    case 'boolean':  { const r = params.get(key); return r === null ? def.default ?? false : r === '1' || r === 'true'; }
    case 'string[]': { const r = params.get(key); return r ? r.split(',').filter(Boolean) : def.default ?? []; }
    case 'sort':     return { column: params.get('sort') ?? def.defaultColumn, dir: (params.get('dir') ?? def.defaultDir ?? 'desc') as SortDir };
  }
}

function isDef(value: unknown, def: ParamDef): boolean {
  switch (def.type) {
    case 'string':   return value === (def.default ?? '');
    case 'boolean':  return value === (def.default ?? false);
    case 'string[]': { const a = value as string[], d = def.default ?? []; return a.length === d.length && a.every((v, i) => v === d[i]); }
    case 'sort':     { const s = value as { column: string; dir: SortDir }; return s.column === def.defaultColumn && s.dir === (def.defaultDir ?? 'desc'); }
  }
}

function write(p: URLSearchParams, key: string, value: unknown, def: ParamDef): void {
  if (def.type === 'sort') {
    p.delete('sort'); p.delete('dir');
    if (!isDef(value, def)) {
      const s = value as { column: string; dir: SortDir };
      if (s.column !== (def as { defaultColumn: string }).defaultColumn) p.set('sort', s.column);
      if (s.dir !== ((def as { defaultDir?: SortDir }).defaultDir ?? 'desc')) p.set('dir', s.dir);
    }
  } else {
    p.delete(key);
    if (!isDef(value, def)) {
      switch (def.type) {
        case 'string':   p.set(key, value as string); break;
        case 'boolean':  p.set(key, (value as boolean) ? '1' : '0'); break;
        case 'string[]': p.set(key, (value as string[]).join(',')); break;
      }
    }
  }
}

// ── Factory ─────────────────────────────────────────────

export function createFilterParams<T extends ParamDefs>(defs: T) {
  const setterKeys = Object.fromEntries(
    Object.keys(defs).map(k => [k, `set${k[0].toUpperCase()}${k.slice(1)}`]),
  ) as Record<keyof T, string>;

  return function useFilterParams(): FilterResult<T> {
    const [params, setParams] = useSearchParams();

    const values = useMemo(() => {
      const r: Record<string, unknown> = {};
      for (const [k, d] of Object.entries(defs)) r[k] = read(params, k, d);
      return r as InferValues<T>;
    }, [params]);

    const hasFilters = useMemo(() => {
      for (const [k, d] of Object.entries(defs)) if (!isDef(values[k], d)) return true;
      return false;
    }, [values]);

    const makeSetter = useCallback((key: string, def: ParamDef) => {
      if (def.type === 'sort') {
        return (column: string) => {
          const cur = values[key] as { column: string; dir: SortDir };
          const dir = column === cur.column ? (cur.dir === 'desc' ? 'asc' : 'desc') : (def.defaultDir ?? 'desc');
          setParams(p => { write(p, key, { column, dir }, def); return p; }, { replace: true });
        };
      }
      return (value: unknown) => {
        const resolved = value ?? (def.type === 'string' ? '' : def.type === 'boolean' ? false : []);
        setParams(p => { write(p, key, resolved, def); return p; }, { replace: true });
      };
    }, [values, setParams]);

    const setters = useMemo(() => {
      const r: Record<string, unknown> = {};
      for (const [k, d] of Object.entries(defs)) r[setterKeys[k]] = makeSetter(k, d);
      return r;
    }, [makeSetter]);

    const clearFilters = useCallback(() => {
      setParams(p => {
        for (const [k, d] of Object.entries(defs)) {
          if (d.type === 'sort') { p.delete('sort'); p.delete('dir'); }
          else p.delete(k);
        }
        return p;
      }, { replace: true });
    }, [setParams]);

    const toParams = useCallback(() => {
      const r: Record<string, string> = {};
      for (const [k, d] of Object.entries(defs)) {
        const v = values[k];
        if (isDef(v, d)) continue;
        if (d.type === 'sort') {
          const s = v as { column: string; dir: SortDir };
          r.sort = s.column;
          r.dir = s.dir;
        } else if (d.type === 'string[]') {
          r[k] = (v as string[]).join(',');
        } else {
          r[k] = String(v);
        }
      }
      return r;
    }, [values]);

    return { ...values, ...setters, hasFilters, clearFilters, toParams } as FilterResult<T>;
  };
}
