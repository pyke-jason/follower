import { useState, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queries } from '@/lib/queries';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { useSearchParam } from '@/hooks/use-search-param';
import { Badge } from '@/components/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Progress } from '@/components/ui/progress';
import { DataTable } from '@/components/data-table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CollapsibleError } from '@/views/backtests/[id]/collapsible-error';
import { LogViewer } from '@/views/backtests/[id]/log-viewer';
import { QueryBoundary, MetricStripSkeleton } from '@/components/query-boundary';
import { formatInteger, formatDate, isoToDateKey, formatCurrency } from '@/lib/format';
import { getClassifierSignalsFromSnapshot } from '@/lib/snapshot-accessors';
import { Square, Trash2, ArrowLeft } from 'lucide-react';
import type { Column } from '@/lib/api-types';
import type {
  ClassifyDetailResponse,
  ClassifyDecisionRow,
  ClassifyLabelRow,
} from '@src/local-api/http-schemas';
import type { Signal } from '@src/agent/schemas';
import { FieldDiffTable, DiffSummaryBadge, computeDiffSummary } from './diff-cell';

const OUTCOMES = ['ALL', 'EXECUTE', 'SKIP', 'MANUAL_REVIEW', 'ERROR'] as const;

export default function ClassifyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const query = useQuery(queries.classify.detail(id!));

  return (
    <QueryBoundary query={query} skeleton={<MetricStripSkeleton count={4} />}>
      {(data) => <ClassifyDetailContent data={data} id={id!} />}
    </QueryBoundary>
  );
}

function ClassifyDetailContent({ data, id }: {
  data: ClassifyDetailResponse;
  id: string;
}) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [outcomeFilter, setOutcomeFilter] = useSearchParam('outcome', 'ALL');

  const cancelMut = useApiMutation('POST', `/classify/${id}/cancel`, {
    invalidate: [['classify', id]],
    onSuccess: () => toast.success('Classify run cancelled'),
  });

  const deleteMut = useApiMutation('DELETE', `/classify/${id}`, {
    onSuccess: () => {
      toast.success('Classify run deleted');
      navigate('/classify');
    },
  });

  const { run, decisions, labelsByMessageId } = data;
  const config = run.config;
  const summary = run.summary;
  const isRunning = run.status === 'RUNNING' || run.status === 'PENDING';

  const filtered = useMemo(() => {
    if (outcomeFilter === 'ALL' || !outcomeFilter) return decisions;
    return decisions.filter((d) => d.decision.outcome === outcomeFilter);
  }, [decisions, outcomeFilter]);

  const progressPct = (() => {
    const total = run.progressTotal ?? 0;
    const done = run.progressIndex ?? 0;
    if (total === 0) return 0;
    return Math.min(100, Math.round((done / total) * 100));
  })();

  const totalTokens = summary ? summary.totalInputTokens + summary.totalOutputTokens : 0;
  const totalCostUsd = summary?.totalCostUsd ?? null;

  return (
    <div className="flex flex-col h-full">
      <div className="space-y-4 animate-in-up pb-6 flex-1 flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link to="/classify" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h2 className="text-lg font-bold text-foreground tracking-tight">Classify Run</h2>
          <Badge label={run.status} />
          {run.name && <span className="text-sm text-muted-foreground">{run.name}</span>}

          <div className="flex items-center gap-1.5 ml-auto">
            {isRunning && (
              <>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => cancelMut.mutate()}
                  disabled={cancelMut.isPending}
                >
                  <Square className="size-3" /> Cancel
                </Button>
                <Separator orientation="vertical" className="!h-4 mx-1" />
              </>
            )}
            <Button
              variant="ghost"
              size="xs"
              className="text-loss hover:text-loss/80 hover:bg-loss/5"
              onClick={() => setConfirmDelete(true)}
              disabled={deleteMut.isPending}
            >
              <Trash2 className="size-3" /> Delete
            </Button>
          </div>
        </div>

        {/* Info bar: config + progress + summary */}
        <div className="rounded-lg border bg-card text-sm overflow-hidden">
          {/* Config row */}
          <div className="flex items-center gap-3 px-4 py-2 border-b border-border/40 text-xs text-muted-foreground flex-wrap">
            <span className="text-foreground font-medium text-sm">{config.traders.join(', ')}</span>
            <Separator orientation="vertical" className="!h-3.5" />
            <span className="font-mono tabular-nums">
              {isoToDateKey(config.startDate)} &ndash; {isoToDateKey(config.endDate)}
            </span>
            <Separator orientation="vertical" className="!h-3.5" />
            <span>{config.agentProvider ?? 'anthropic'}/{config.agentModel ?? 'default'}</span>
            {config.concurrency != null && <span className="font-mono">concurrency {config.concurrency}</span>}
            {run.experimentTag && (
              <span className="text-[10px] bg-muted/40 px-1.5 py-0.5 rounded border border-border/30 border-dashed">
                {run.experimentTag}
              </span>
            )}
          </div>

          {/* Outcome metrics row */}
          {summary && (
            <div className="flex items-end gap-6 px-4 py-3 flex-wrap">
              <Metric label="Total" value={formatInteger(summary.totalMessages)} />
              <Metric label="Tradable" value={formatInteger(summary.tradableMessages)} />
              <Metric label="Processed" value={formatInteger(summary.processedMessages)} />
              <Separator orientation="vertical" className="!h-8" />
              <Metric label="Execute" value={formatInteger(summary.byOutcome.EXECUTE ?? 0)} color="text-profit" />
              <Metric label="Skip" value={formatInteger(summary.byOutcome.SKIP ?? 0)} muted />
              <Metric label="Review" value={formatInteger(summary.byOutcome.MANUAL_REVIEW ?? 0)} color="text-warning" />
              <Metric label="Error" value={formatInteger(summary.byOutcome.ERROR ?? 0)} color="text-loss" />
              <Separator orientation="vertical" className="!h-8" />
              <Metric label="Hard-skip" value={formatInteger(summary.byRoute['hard-skip'] ?? 0)} muted />
              <Metric label="Determin." value={formatInteger(summary.byRoute.deterministic ?? 0)} muted />
              <Metric label="LLM" value={formatInteger(summary.byRoute.llm ?? 0)} muted />
              <Separator orientation="vertical" className="!h-8" />
              <Metric label="Tokens" value={totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : String(totalTokens)} muted />
              <Metric
                label="Cost"
                value={totalCostUsd != null ? formatCurrency(totalCostUsd, 4) : '—'}
                muted
              />
            </div>
          )}

          {/* Progress bar (running) */}
          {isRunning && (run.progressTotal ?? 0) > 0 && (
            <div className="px-4 py-2 border-t border-border/40 flex items-center gap-3">
              <Progress value={progressPct} className="h-1.5 flex-1" />
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatInteger(run.progressIndex ?? 0)}/{formatInteger(run.progressTotal ?? 0)}
              </span>
            </div>
          )}
        </div>

        {/* Error (hide when cancelled) */}
        {run.error && run.status !== 'CANCELLED' && (
          <CollapsibleError error={run.error} />
        )}

        {/* Filter + table */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Outcome:</span>
          <ToggleGroup
            type="single"
            value={outcomeFilter ?? 'ALL'}
            onValueChange={(v) => v && setOutcomeFilter(v === 'ALL' ? null : v)}
            variant="outline"
            size="sm"
          >
            {OUTCOMES.map((o) => (
              <ToggleGroupItem key={o} value={o} className="text-xs">
                {o === 'ALL' ? 'All' : o}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {formatInteger(filtered.length)} decision{filtered.length === 1 ? '' : 's'}
          </span>
        </div>

        <DecisionsTable rows={filtered} labelsByMessageId={labelsByMessageId} />
      </div>

      <LogViewer backtestRunId={id} isRunning={isRunning} defaultCollapsed />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this classify run?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes all decisions and logs for this run. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleteMut.mutate()}>
              Delete Run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Metric({ label, value, color, muted }: {
  label: string;
  value: string;
  color?: string;
  muted?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground mb-0.5">{label}</div>
      <div className={`text-sm font-mono font-semibold tabular-nums ${color ?? ''} ${muted ? 'text-muted-foreground' : ''}`}>
        {value}
      </div>
    </div>
  );
}

/** Resolve the label's first trade (Signal[]) — prefers humanLabel when reviewed. */
function getLabelSignals(label: ClassifyLabelRow | undefined): { isTrade: boolean | null; trade: Signal[] | null } {
  if (!label) return { isTrade: null, trade: null };
  const active = label.humanLabel ?? label.label;
  if (!active) return { isTrade: null, trade: null };
  const isTrade = !!active.isTrade;
  const trade = active.trades?.[0] ?? null;
  return { isTrade, trade };
}

function DecisionsTable({ rows, labelsByMessageId }: {
  rows: ClassifyDecisionRow[];
  labelsByMessageId: Record<string, ClassifyLabelRow>;
}) {
  const columns: Column<ClassifyDecisionRow>[] = [
    {
      key: 'timestamp',
      label: 'Time',
      className: 'text-muted-foreground text-xs tabular-nums w-[130px]',
      render: (row) => <>{formatDate(row.message.timestamp)}</>,
    },
    {
      key: 'author',
      label: 'Author',
      className: 'text-xs w-[110px] truncate',
      render: (row) => <span className="font-medium">{row.message.author}</span>,
    },
    {
      key: 'outcome',
      label: 'Outcome',
      className: 'w-[100px]',
      render: (row) => row.decision.outcome
        ? <Badge label={row.decision.outcome} />
        : <span className="text-muted-foreground/50 text-xs">--</span>,
    },
    {
      key: 'text',
      label: 'Message',
      className: 'text-xs max-w-0',
      render: (row) => (
        <span className="text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis block" title={row.message.cleanText ?? ''}>
          {row.message.cleanText ?? ''}
        </span>
      ),
    },
    {
      key: 'diff',
      label: 'Label vs Classifier',
      className: 'text-xs w-[170px]',
      render: (row) => {
        const mid = row.decision.messageId;
        const label = mid ? labelsByMessageId[mid] : undefined;
        const { isTrade, trade } = getLabelSignals(label);
        const classifier = getClassifierSignalsFromSnapshot(row.decision.snapshot);
        const labelSignal = trade?.[0] ?? null;
        const classifierSignal = classifier[0] ?? null;
        const summary = computeDiffSummary(labelSignal, classifier.length > 0 ? classifierSignal : null);
        return (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="hover:bg-accent/40 rounded px-2 py-0.5 -mx-2 transition-colors">
                <DiffSummaryBadge
                  summary={summary}
                  labelIsTrade={isTrade}
                  classifierIsTrade={classifier.length > 0}
                />
              </button>
            </PopoverTrigger>
            <PopoverContent side="left" align="start" className="w-[520px] p-2">
              <DiffPopoverBody label={labelSignal} classifier={classifierSignal} labelTrade={trade} classifierSignals={classifier} />
            </PopoverContent>
          </Popover>
        );
      },
    },
    {
      key: 'reasoning',
      label: 'Reasoning',
      className: 'text-xs max-w-0',
      render: (row) => (
        <span className="text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis block" title={row.decision.reasoning ?? ''}>
          {row.decision.reasoning ?? ''}
        </span>
      ),
    },
    {
      key: 'tokens',
      label: 'tok',
      align: 'right',
      className: 'text-xs text-muted-foreground tabular-nums w-[70px]',
      render: (row) => {
        const input = row.decision.inputTokens ?? 0;
        const output = row.decision.outputTokens ?? 0;
        const total = input + output;
        return <>{total || '--'}</>;
      },
    },
  ];

  const rowClassName = (row: ClassifyDecisionRow): string => {
    const mid = row.decision.messageId;
    const label = mid ? labelsByMessageId[mid] : undefined;
    const { isTrade, trade } = getLabelSignals(label);
    const classifier = getClassifierSignalsFromSnapshot(row.decision.snapshot);
    if (isTrade == null) return '';
    const classifierIsTrade = classifier.length > 0;
    if (isTrade !== classifierIsTrade) return 'bg-loss/5';
    const labelSignal = trade?.[0] ?? null;
    const summary = computeDiffSummary(labelSignal, classifier[0] ?? null);
    return summary && summary.mismatchedFields > 0 ? 'bg-loss/5' : '';
  };

  return (
    <DataTable
      columns={columns}
      data={rows}
      rowClassName={rowClassName}
      getRowKey={(row) => row.decision.messageId ?? row.decision.id}
      className="flex-1 min-h-[400px]"
    />
  );
}

function DiffPopoverBody({ label, classifier, labelTrade, classifierSignals }: {
  label: Signal | null;
  classifier: Signal | null;
  labelTrade: Signal[] | null;
  classifierSignals: Signal[];
}) {
  const labelCount = labelTrade?.length ?? 0;
  const classifierCount = classifierSignals.length;
  const countMismatch = labelCount !== classifierCount;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Label signals: <span className="font-mono">{labelCount}</span></span>
        <span>Classifier signals: <span className="font-mono">{classifierCount}</span></span>
      </div>
      {countMismatch && (
        <div className="text-[11px] text-loss font-mono">signal count mismatch</div>
      )}
      <FieldDiffTable label={label} classifier={classifier} />
    </div>
  );
}
