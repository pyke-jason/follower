import { useState, useMemo, useCallback } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { QueryBoundary } from '@/components/query-boundary';
import { api } from '@/lib/api';
import { useDbBrowserParams } from '@/hooks/use-db-browser-params';
import { SchemaGraph } from './schema-graph';
import { TableViewer } from './table-viewer';
import { TableFilters } from './table-filters';
import type { TableMeta, TableDataResponse, Filter } from '@src/local-api/db-browser-types';

export default function DbBrowserPage() {
  const { table, sort, filters, setTable, setSort, setFilters } = useDbBrowserParams();
  const [panelOpen, setPanelOpen] = useState(!!table);

  const tablesQuery = useQuery({ queryKey: ['db-tables'], queryFn: () => api<TableMeta[]>('/db/tables') });
  const activeTable = table || '';

  const activeFilters = useMemo<Filter[]>(() => { try { return filters ? JSON.parse(filters) : []; } catch { return []; } }, [filters]);

  const handleSelectTable = useCallback((name: string) => {
    setTable(name);
    setPanelOpen(true);
  }, [setTable]);

  const dataQuery = useQuery({
    queryKey: ['db-table-data', activeTable, sort.column, sort.dir, filters],
    queryFn: () => {
      const qs = new URLSearchParams({ limit: '100', offset: '0', sort: sort.column, dir: sort.dir });
      if (filters) qs.set('filters', filters);
      return api<TableDataResponse>(`/db/tables/${activeTable}?${qs}`);
    },
    enabled: !!activeTable && panelOpen,
  });

  return (
    <div className="-mx-6 -mt-6 h-[calc(100vh-var(--banner-h,0px)-3.5rem)]">
      <QueryBoundary query={tablesQuery}>
        {(tables) => (
          <div className="flex h-full">
            <div className="flex-1 min-w-0 h-full">
              <SchemaGraph tables={tables} selectedTable={activeTable} onSelectTable={handleSelectTable} />
            </div>
            {panelOpen && activeTable && (
              <div className="flex-[1.4] flex flex-col min-w-0 border-l">
                <RightPanel
                  tables={tables}
                  activeTable={activeTable}
                  dataQuery={dataQuery}
                  activeFilters={activeFilters}
                  sort={sort}
                  setSort={setSort}
                  setFilters={(f) => setFilters(f.length ? JSON.stringify(f) : null)}
                  onClose={() => setPanelOpen(false)}
                />
              </div>
            )}
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

// ── Right panel ────────────────────────────────────────────────────────────────

function RightPanel({ tables, activeTable, dataQuery, activeFilters, sort, setSort, setFilters, onClose }: {
  tables: TableMeta[];
  activeTable: string;
  dataQuery: UseQueryResult<TableDataResponse>;
  activeFilters: Filter[];
  sort: { column: string; dir: 'asc' | 'desc' };
  setSort: (col: string) => void;
  setFilters: (f: Filter[]) => void;
  onClose: () => void;
}) {
  const tableMeta = tables.find((t) => t.name === activeTable);
  const pk = tableMeta?.columns.find((c) => c.primaryKey)?.name ?? null;

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-card shrink-0">
        <span className="font-semibold text-sm">{activeTable}</span>
        {dataQuery.data && (
          <>
            <Badge variant="secondary" className="text-[10px]">{dataQuery.data.total} rows</Badge>
            {dataQuery.data.rows.length < dataQuery.data.total && (
              <span className="text-xs text-muted-foreground">
                Showing {dataQuery.data.rows.length} of {dataQuery.data.total}
              </span>
            )}
          </>
        )}
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      {tableMeta && <TableFilters columns={tableMeta.columns} filters={activeFilters} onChange={setFilters} />}
      <QueryBoundary query={dataQuery}>
        {(data) => (
          <div className="flex-1 min-h-0 overflow-hidden">
            <TableViewer columns={data.columns} data={data.rows} sort={sort} onSortChange={setSort} primaryKey={pk} />
          </div>
        )}
      </QueryBoundary>
    </>
  );
}
