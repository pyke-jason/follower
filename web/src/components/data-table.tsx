import { useCallback, useMemo } from 'react';
import { TableVirtuoso } from 'react-virtuoso';
import { ArrowUp, ArrowDown, ArrowUpDown, Loader2 } from 'lucide-react';
import { EmptyState } from './empty-state';
import { useSort, type SortState } from '@/hooks/use-sort';
import { cn } from '@/lib/utils';
import type { Column } from '@/lib/api-types';

// ── Table component overrides for Virtuoso ──────────────

const thClass =
  'text-muted-foreground h-9 px-3 text-left align-middle text-[10px] font-medium uppercase tracking-[0.1em] whitespace-nowrap';
const trClass =
  'hover:bg-accent/40 border-b transition-colors';

interface TableContext<T> {
  rowClassName?: (row: T) => string;
}

function buildVirtuosoComponents<T>() {
  return {
    Table: ({ style, ...props }: React.ComponentProps<'table'> & { style?: React.CSSProperties }) => (
      <table style={{ ...style, tableLayout: 'fixed' }} className="w-full caption-bottom text-sm" {...props} />
    ),
    TableHead: ({ ref, ...props }: React.ComponentProps<'thead'> & { ref?: React.Ref<HTMLTableSectionElement> }) => (
      <thead ref={ref} className="[&_tr]:border-b bg-card sticky top-0 z-10" {...props} />
    ),
    TableBody: ({ ref, ...props }: React.ComponentProps<'tbody'> & { ref?: React.Ref<HTMLTableSectionElement> }) => (
      <tbody ref={ref} className="[&_tr:last-child]:border-0" {...props} />
    ),
    // SAFETY: react-virtuoso passes `item` and `context` in TableRow props
    TableRow: ({ style, item, context, ...props }: React.ComponentProps<'tr'> & { style?: React.CSSProperties; item?: T; context?: TableContext<T> }) => (
      <tr style={style} className={cn(trClass, item && context?.rowClassName?.(item))} {...props} />
    ),
  };
}

// ── Sort comparator ─────────────────────────────────────

function defaultCompare<T>(a: T, b: T, key: string): number {
  const aVal = (a as Record<string, unknown>)[key];
  const bVal = (b as Record<string, unknown>)[key];
  if (aVal == null && bVal == null) return 0;
  if (aVal == null) return 1;
  if (bVal == null) return -1;
  if (typeof aVal === 'number' && typeof bVal === 'number') return aVal - bVal;
  return String(aVal).localeCompare(String(bVal));
}

// ── DataTable ───────────────────────────────────────────

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  defaultSort?: { column: string; dir?: 'asc' | 'desc' };
  onRowClick?: (row: T, index: number) => void;
  rowClassName?: (row: T) => string;
  /** Custom sort comparator. Falls back to generic string/number compare. */
  compare?: (a: T, b: T, column: string) => number;
  /** Fixed height container. Default: fills parent via h-full. */
  className?: string;
  /** Custom empty state. Falls back to `<EmptyState title="No data" />`. */
  emptyState?: React.ReactNode;
  // ── Infinite scroll ───────────────────────────────────
  /** Called when the user scrolls near the bottom. Wire to `loadMore()` from `useInfiniteList`. */
  onEndReached?: () => void;
  /** Show a loading indicator below the last row while fetching the next page. */
  isLoadingMore?: boolean;
  // ── Controlled (server-side) sort ─────────────────────
  /** Controlled sort state. When provided, internal sort is disabled and data is rendered as-is. */
  sort?: SortState<string>;
  /** Called when the user clicks a sortable column header. Required when `sort` is provided. */
  onSortChange?: (column: string) => void;
  /**
   * Stable row identity. When provided, Virtuoso keys rows by the returned
   * string instead of index — preventing popover/hover state from re-attaching
   * to a different row when the data refetches and shifts. Strongly recommended
   * whenever rows live through data updates.
   */
  getRowKey?: (row: T) => string;
}

export function DataTable<T>({
  columns,
  data,
  defaultSort,
  onRowClick,
  rowClassName,
  compare,
  className,
  emptyState,
  onEndReached,
  isLoadingMore,
  sort: controlledSort,
  onSortChange,
  getRowKey,
}: DataTableProps<T>) {
  // Controlled sort: parent owns state (server-side sort for infinite scroll).
  // Uncontrolled sort: internal state with client-side sorting (static data).
  const internal = useSort(defaultSort?.column ?? columns[0]?.key ?? '', defaultSort?.dir);
  const isControlled = controlledSort !== undefined;
  const sort = isControlled ? controlledSort : internal.sort;
  const toggle = isControlled
    ? (col: string) => onSortChange?.(col)
    : internal.toggle;

  const sorted = useMemo(() => {
    // When sort is controlled, data is already sorted by the server.
    if (isControlled) return data;
    const cmp = compare ?? defaultCompare;
    const arr = [...data];
    arr.sort((a, b) => {
      const result = cmp(a, b, sort.column);
      return sort.dir === 'desc' ? -result : result;
    });
    return arr;
  }, [data, sort, compare, isControlled]);

  const components = useMemo(() => buildVirtuosoComponents<T>(), []);
  const context = useMemo((): TableContext<T> => ({ rowClassName }), [rowClassName]);

  const renderRow = useCallback(
    (index: number, row: T) => (
      <>
        {columns.map((col) => (
          <td
            key={col.key}
            className={cn(
              'p-2 align-middle text-sm [&:has([role=checkbox])]:pr-0',
              col.align === 'right' && 'text-right',
              col.className,
            )}
            onClick={onRowClick ? () => onRowClick(row, index) : undefined}
          >
            {col.render(row)}
          </td>
        ))}
      </>
    ),
    [columns, onRowClick],
  );

  const renderHeader = useCallback(
    () => (
      <tr className={cn(trClass, 'bg-card')}>
        {columns.map((col) => {
          if (!col.sortable) {
            return (
              <th key={col.key} className={cn(thClass, col.align === 'right' && 'text-right', col.className)}>
                {col.label}
              </th>
            );
          }
          const isActive = sort.column === col.key;
          const Icon = isActive
            ? sort.dir === 'desc'
              ? ArrowDown
              : ArrowUp
            : ArrowUpDown;
          return (
            <th
              key={col.key}
              className={cn(thClass, 'cursor-pointer select-none hover:text-foreground', col.className)}
              onClick={() => toggle(col.key)}
            >
              <span className={cn('inline-flex items-center gap-1', col.align === 'right' && 'justify-end')}>
                {col.label}
                <Icon className={cn('size-3.5 shrink-0', !isActive && 'opacity-30')} />
              </span>
            </th>
          );
        })}
      </tr>
    ),
    [columns, sort, toggle],
  );

  if (data.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border/40">
        {emptyState ?? <EmptyState title="No data" />}
      </div>
    );
  }

  return (
    <div className={cn('rounded-md border bg-card overflow-hidden', className)}>
      <TableVirtuoso
        style={{ height: '100%' }}
        data={sorted}
        overscan={100}
        components={components}
        context={context}
        fixedHeaderContent={renderHeader}
        itemContent={renderRow}
        {...(getRowKey ? { computeItemKey: (_index: number, row: T) => getRowKey(row) } : {})}
        endReached={onEndReached}
        increaseViewportBy={200}
      />
      {isLoadingMore && (
        <div className="flex items-center justify-center py-2 border-t">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
