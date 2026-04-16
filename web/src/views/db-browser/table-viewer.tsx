import { useState, useMemo } from 'react';
import { Expand } from 'lucide-react';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { Column } from '@/lib/api-types';
import type { SortState } from '@/hooks/use-sort';
import type { ColumnMeta } from '@src/local-api/db-browser-types';

// ── JSON expand dialog ───────────────────────────────────────────────────────

function JsonDialog({ value, onClose }: { value: string; onClose: () => void }) {
  let formatted = value;
  try {
    formatted = JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    // leave as-is if not valid JSON
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>JSON value</DialogTitle>
        </DialogHeader>
        <pre className="text-xs bg-muted rounded-md p-4 overflow-auto max-h-[60vh] whitespace-pre-wrap break-all">
          {formatted}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

// ── Cell renderers ───────────────────────────────────────────────────────────

function CellValue({ value, onCellEdit }: {
  value: unknown;
  onCellEdit?: () => void;
}) {
  const [jsonOpen, setJsonOpen] = useState(false);

  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/50 text-xs italic">null</span>;
  }

  if (typeof value === 'number') {
    return (
      <span
        className="tabular-nums cursor-pointer hover:underline"
        onClick={onCellEdit}
      >
        {value.toLocaleString()}
      </span>
    );
  }

  const str = String(value);

  // JSON-shaped strings
  if (str.startsWith('{') || str.startsWith('[')) {
    const truncated = str.length > 80 ? `${str.slice(0, 80)}…` : str;
    return (
      <>
        <span
          // PERF: title used for virtualized row
          title={str}
          className="truncate block cursor-pointer hover:underline"
          onClick={onCellEdit}
        >
          {truncated}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="h-4 w-4 p-0 ml-1 inline-flex shrink-0"
          onClick={(e) => { e.stopPropagation(); setJsonOpen(true); }}
        >
          <Expand className="size-3" />
        </Button>
        {jsonOpen && <JsonDialog value={str} onClose={() => setJsonOpen(false)} />}
      </>
    );
  }

  return (
    <span
      // PERF: title used for virtualized row
      title={str.length > 20 ? str : undefined}
      className="truncate block cursor-pointer hover:underline"
      onClick={onCellEdit}
    >
      {str}
    </span>
  );
}

// ── Column width heuristics ─────────────────────────────────────────────────

function getColumnWidth(meta: ColumnMeta): string | undefined {
  const name = meta.name.toLowerCase();
  const isNumeric = meta.type === 'INTEGER' || meta.type === 'REAL';

  if (name === 'id' || name.endsWith('_id')) return 'w-[100px]';
  if (name.endsWith('_at') || name.endsWith('_date') || name.endsWith('_time')) return 'w-[155px]';
  if (isNumeric) return 'w-[80px]';
  return undefined; // text columns share remaining space
}

// ── Column builder ───────────────────────────────────────────────────────────

function buildColumns(
  columnMetas: ColumnMeta[],
  primaryKey: string | null,
  onCellEdit?: (rowId: string, column: string, value: unknown) => void,
): Column<Record<string, unknown>>[] {
  return columnMetas.map((meta) => {
    const isNumeric = meta.type === 'INTEGER' || meta.type === 'REAL';
    const width = getColumnWidth(meta);
    return {
      key: meta.name,
      label: meta.name,
      sortable: true,
      align: isNumeric ? 'right' : 'left',
      className: width,
      render: (row) => {
        const value = row[meta.name];
        const rowId = primaryKey ? String(row[primaryKey]) : '';
        return (
          <CellValue
            value={value}
            onCellEdit={onCellEdit && rowId ? () => onCellEdit(rowId, meta.name, value) : undefined}
          />
        );
      },
    };
  });
}

// ── TableViewer ──────────────────────────────────────────────────────────────

interface TableViewerProps {
  columns: ColumnMeta[];
  data: Record<string, unknown>[];
  sort: SortState<string>;
  onSortChange: (col: string) => void;
  onCellEdit?: (rowId: string, column: string, value: unknown) => void;
  primaryKey: string | null;
}

export function TableViewer({
  columns,
  data,
  sort,
  onSortChange,
  onCellEdit,
  primaryKey,
}: TableViewerProps) {
  const tableColumns = useMemo(
    () => buildColumns(columns, primaryKey, onCellEdit),
    [columns, primaryKey, onCellEdit],
  );

  return (
    <DataTable
      columns={tableColumns}
      data={data}
      sort={sort}
      onSortChange={onSortChange}
      className={cn('h-full flex-1')}
    />
  );
}
