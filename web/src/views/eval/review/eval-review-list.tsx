import { useMemo } from 'react';
import { FilterX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateShort } from '@/lib/format';
import { DataTable } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useEvalReviewParams } from '@/hooks/use-eval-review-params';
import type { Column } from '@/lib/api-types';
import type { LabelRow, LabelsResponse } from './types';

// ── Tiny render helper (<10 lines) ──────────────────────────────────────────

function ConfidenceDot({ confidence }: { confidence: string }) {
  const isLow = confidence === 'LOW';
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[10px] font-medium',
      isLow ? 'text-warning' : 'text-muted-foreground',
    )}>
      <span className={cn('w-1.5 h-1.5 rounded-full', isLow ? 'bg-warning' : 'bg-muted-foreground/40')} />
    </span>
  );
}

// ── Column definitions ──────────────────────────────────────────────────────

const columns: Column<LabelRow>[] = [
  {
    key: 'timestamp',
    label: 'Date',
    sortable: true,
    className: 'w-[56px]',
    render: (row) => (
      <span className="text-[10px] text-muted-foreground tabular-nums">
        {formatDateShort(row.timestamp)}
      </span>
    ),
  },
  {
    key: 'author',
    label: 'Author',
    className: 'w-[70px]',
    render: (row) => <span className="truncate block">{row.author}</span>,
  },
  {
    key: 'cleanText',
    label: 'Message',
    // PERF: title used for virtualized row
    render: (row) => <span title={row.cleanText} className="truncate block">{row.cleanText.slice(0, 120)}</span>,
  },
  {
    key: 'confidence',
    label: 'Conf',
    className: 'w-[32px]',
    render: (row) => <ConfidenceDot confidence={row.label.confidence} />,
  },
  {
    key: 'humanVerified',
    label: 'V',
    className: 'w-[20px]',
    render: (row) => row.humanVerified ? (
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[8px] font-bold text-background bg-profit">
        V
      </span>
    ) : null,
  },
];

// ── Filter bar ──────────────────────────────────────────────────────────────

function FilterBar({ stats }: { stats: LabelsResponse['stats'] }) {
  const { source, verified, confidence, isTrade, hasFilters, clearFilters, setSource, setVerified, setConfidence, setIsTrade } = useEvalReviewParams();
  const pct = stats.total > 0 ? Math.round((stats.verified / stats.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-1 px-2 py-1.5 border-b shrink-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={verified || 'all'}
          onValueChange={v => { if (v) setVerified(v === 'all' ? '' : v); }}
        >
          <ToggleGroupItem value="all" className="text-xs h-6 px-2">All</ToggleGroupItem>
          <ToggleGroupItem value="false" className="text-xs h-6 px-2">Unreviewed</ToggleGroupItem>
          <ToggleGroupItem value="true" className="text-xs h-6 px-2">Verified</ToggleGroupItem>
        </ToggleGroup>

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={isTrade || 'all'}
          onValueChange={v => { if (v) setIsTrade(v === 'all' ? '' : v); }}
        >
          <ToggleGroupItem value="all" className="text-xs h-6 px-2">All</ToggleGroupItem>
          <ToggleGroupItem value="true" className="text-xs h-6 px-2">Trade</ToggleGroupItem>
          <ToggleGroupItem value="false" className="text-xs h-6 px-2">Not trade</ToggleGroupItem>
        </ToggleGroup>

        <div className="flex-1" />
        <span className="text-xs text-muted-foreground tabular-nums">{stats.verified}/{stats.total}</span>
        <Progress value={pct} className="w-16 h-1.5" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={confidence || 'all'}
          onValueChange={v => { if (v) setConfidence(v === 'all' ? '' : v); }}
        >
          <ToggleGroupItem value="all" className="text-xs h-6 px-2">All</ToggleGroupItem>
          <ToggleGroupItem value="HIGH" className="text-xs h-6 px-2">HIGH</ToggleGroupItem>
          <ToggleGroupItem value="LOW" className="text-xs h-6 px-2">LOW</ToggleGroupItem>
        </ToggleGroup>

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={source || 'all'}
          onValueChange={v => { if (v) setSource(v === 'all' ? '' : v); }}
        >
          <ToggleGroupItem value="all" className="text-xs h-6 px-2">All</ToggleGroupItem>
          <ToggleGroupItem value="agent" className="text-xs h-6 px-2">Agent</ToggleGroupItem>
          <ToggleGroupItem value="human" className="text-xs h-6 px-2">Human</ToggleGroupItem>
        </ToggleGroup>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="text-xs h-6 px-1.5 text-muted-foreground gap-1"
          >
            <FilterX className="size-3" />
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

// ── List component ──────────────────────────────────────────────────────────

export function EvalReviewList({ data, currentId, onSelect }: {
  data: LabelsResponse;
  currentId: string | null;
  onSelect: (id: string) => void;
}) {
  const { sort, setSort } = useEvalReviewParams();

  const rowClassName = useMemo(() => {
    return (row: LabelRow) => cn(
      row.id === currentId && 'bg-accent',
      row.humanVerified && 'border-l-2 border-l-profit',
      !row.humanVerified && 'border-l-2 border-l-transparent',
    );
  }, [currentId]);

  return (
    <div className="flex flex-col h-full">
      <FilterBar stats={data.stats} />
      {data.rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            variant="filtered"
            title="No matching labels"
            hint="Try adjusting your filters"
            icon={<FilterX className="size-6 text-muted-foreground" />}
          />
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={data.rows}
          sort={sort}
          onSortChange={setSort}
          onRowClick={(row) => onSelect(row.id)}
          rowClassName={rowClassName}
          className="flex-1 border-0 rounded-none"
        />
      )}
    </div>
  );
}
