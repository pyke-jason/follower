import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { MetricStrip, type Metric } from '@/components/metric-strip';
import { Badge } from '@/components/badge';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { QueryBoundary, MetricStripSkeleton } from '@/components/query-boundary';
import { formatInteger } from '@/lib/format';

// ── Types ──────────────────────────────────────────────────────────────────

type EvalDiscrepancy = {
  messageId: string;
  author: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
  timestamp: string;
  category: string;
  parserAction: string | null;
  parserStrategy: string | null;
  parserDirection: string | null;
  parserSkipReason: string | null;
  parserFlags: string[];
  labelAction: string | null;
  labelStrategy: string | null;
  labelDirection: string | null;
  labelNotes: string | null;
  verdict: string | null;
  verdictReason: string | null;
};

type EvalResponse = {
  totalMessages: number;
  totalLabeled: number;
  totalWithSignals: number;
  totalSkipLabels: number;
  confusion: {
    parserSkip_labelSkip: number;
    parserSkip_labelExecute: number;
    parserExecute_labelSkip: number;
    parserExecute_labelExecute: number;
    parserNull_labelSkip: number;
    parserNull_labelExecute: number;
  };
  metrics: {
    precision: number;
    recall: number;
    f1: number;
    falseNegatives: number;
    falsePositives: number;
  };
  actionMismatches: Record<string, number>;
  strategyMismatches: Record<string, number>;
  directionMismatches: Record<string, number>;
  discrepancies: EvalDiscrepancy[];
  filteredTotal: number;
  offset: number;
  limit: number;
  verdictSummary: {
    total: number;
    parserRight: number;
    labelRight: number;
    bothWrong: number;
    unreviewed: number;
  };
};

type Category = 'all' | 'false_positive' | 'false_negative' | 'action_mismatch' | 'strategy_mismatch' | 'direction_mismatch';

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'false_positive', label: 'False Positives' },
  { value: 'false_negative', label: 'False Negatives' },
  { value: 'action_mismatch', label: 'Action Mismatch' },
  { value: 'strategy_mismatch', label: 'Strategy Mismatch' },
  { value: 'direction_mismatch', label: 'Direction Mismatch' },
];

// ── Page ───────────────────────────────────────────────────────────────────

export default function EvalPage() {
  const [category, setCategory] = useState<Category>('all');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const query = useQuery<EvalResponse>({
    queryKey: ['eval', category, page],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (category !== 'all') params.set('category', category);
      return api<EvalResponse>(`/eval?${params}`);
    },
  });

  return (
    <QueryBoundary query={query} skeleton={<MetricStripSkeleton />}>
      {(data) => (
        <EvalContent data={data} category={category} setCategory={setCategory} page={page} setPage={setPage} pageSize={PAGE_SIZE} />
      )}
    </QueryBoundary>
  );
}

function EvalContent({ data, category, setCategory, page, setPage, pageSize }: {
  data: EvalResponse;
  category: Category;
  setCategory: (c: Category) => void;
  page: number;
  setPage: (p: number) => void;
  pageSize: number;
}) {
  const { confusion: cm, metrics } = data;

  const topMetrics: Metric[] = [
    { label: 'Precision', value: metrics.precision, format: 'percent' },
    { label: 'Recall', value: metrics.recall, format: 'percent' },
    { label: 'F1 Score', value: metrics.f1, format: 'percent' },
    { label: 'False Positives', value: metrics.falsePositives, format: 'integer' },
    { label: 'False Negatives', value: metrics.falseNegatives, format: 'integer' },
    { label: 'Messages', value: data.totalMessages, format: 'integer' },
  ];

  return (
    <div className="space-y-6 pb-8 max-w-[1400px]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Parser Evaluation</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {formatInteger(data.totalLabeled)} messages labeled | {formatInteger(data.totalWithSignals)} trades | {formatInteger(data.totalSkipLabels)} skips
          </p>
        </div>
        <Link
          to="/eval/review"
          className="px-4 py-2 text-sm font-medium rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-colors"
        >
          Review Discrepancies
        </Link>
      </div>

      {/* Top-level metrics */}
      <MetricStrip metrics={topMetrics} />

      {/* Confusion Matrix + Verdict Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ConfusionMatrix cm={cm} />
        <VerdictSummary vs={data.verdictSummary} />
      </div>

      {/* Mismatch breakdowns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <MismatchCard title="Action Mismatches" data={data.actionMismatches} />
        <MismatchCard title="Strategy Mismatches" data={data.strategyMismatches} />
        <MismatchCard title="Direction Mismatches" data={data.directionMismatches} />
      </div>

      {/* Discrepancy table */}
      <Card>
        <CardHeader className="border-b py-3 px-4">
          <CardTitle className="text-sm">Discrepancies</CardTitle>
          <div className="flex gap-1 flex-wrap">
            {CATEGORIES.map(cat => (
              <Button
                key={cat.value}
                variant={category === cat.value ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => { setCategory(cat.value); setPage(0); }}
              >
                {cat.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <DiscrepancyTable
            discrepancies={data.discrepancies}
            total={data.filteredTotal}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// ── Confusion Matrix ────────────────────────────────────────────────────────

function ConfusionMatrix({ cm }: { cm: EvalResponse['confusion'] }) {
  const cells = [
    { row: 'Parser: SKIP', col: 'Label: SKIP', value: cm.parserSkip_labelSkip, color: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
    { row: 'Parser: SKIP', col: 'Label: EXEC', value: cm.parserSkip_labelExecute, color: 'bg-red-500/10 text-red-700 dark:text-red-400' },
    { row: 'Parser: EXEC', col: 'Label: SKIP', value: cm.parserExecute_labelSkip, color: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
    { row: 'Parser: EXEC', col: 'Label: EXEC', value: cm.parserExecute_labelExecute, color: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
    { row: 'Parser: LLM', col: 'Label: SKIP', value: cm.parserNull_labelSkip, color: 'bg-muted' },
    { row: 'Parser: LLM', col: 'Label: EXEC', value: cm.parserNull_labelExecute, color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
  ];

  const rows = ['Parser: SKIP', 'Parser: EXEC', 'Parser: LLM'];
  const cols = ['Label: SKIP', 'Label: EXEC'];

  return (
    <Card>
      <CardHeader className="border-b py-3 px-4">
        <CardTitle className="text-sm">Confusion Matrix</CardTitle>
      </CardHeader>
      <CardContent className="pt-4 pb-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]" />
              {cols.map(c => <TableHead key={c} className="text-center text-xs">{c}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => (
              <TableRow key={row}>
                <TableCell className="text-xs font-medium">{row}</TableCell>
                {cols.map(col => {
                  const cell = cells.find(c => c.row === row && c.col === col);
                  return (
                    <TableCell key={col} className={cn('text-center tabular-nums font-semibold', cell?.color)}>
                      {cell ? formatInteger(cell.value) : null}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ── Verdict Summary ─────────────────────────────────────────────────────────

function VerdictSummary({ vs }: { vs: EvalResponse['verdictSummary'] }) {
  const reviewed = vs.parserRight + vs.labelRight + vs.bothWrong;
  const pct = (n: number) => reviewed > 0 ? `${((n / reviewed) * 100).toFixed(1)}%` : '—';

  return (
    <Card>
      <CardHeader className="border-b py-3 px-4">
        <CardTitle className="text-sm">Discrepancy Verdicts</CardTitle>
      </CardHeader>
      <CardContent className="pt-4 pb-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 rounded-lg border px-4 py-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Reviewed</span>
            <span className="text-xl font-semibold">{formatInteger(reviewed)} <span className="text-sm text-muted-foreground">/ {formatInteger(vs.total)}</span></span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border px-4 py-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Unreviewed</span>
            <span className="text-xl font-semibold">{formatInteger(vs.unreviewed)}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border bg-emerald-500/5 px-4 py-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Parser Right</span>
            <span className="text-xl font-semibold text-emerald-700 dark:text-emerald-400">{formatInteger(vs.parserRight)} <span className="text-sm">({pct(vs.parserRight)})</span></span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border bg-amber-500/5 px-4 py-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Label Right</span>
            <span className="text-xl font-semibold text-amber-700 dark:text-amber-400">{formatInteger(vs.labelRight)} <span className="text-sm">({pct(vs.labelRight)})</span></span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Mismatch Card ───────────────────────────────────────────────────────────

function MismatchCard({ title, data }: { title: string; data: Record<string, number> }) {
  const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const total = Object.values(data).reduce((s, n) => s + n, 0);

  return (
    <Card>
      <CardHeader className="border-b py-3 px-4">
        <CardTitle className="text-sm">{title} <span className="text-muted-foreground font-normal">({total})</span></CardTitle>
      </CardHeader>
      <CardContent className="pt-3 pb-2 px-3">
        {sorted.length === 0 ? (
          <EmptyState title="No mismatches" hint="Parser and labels agree" className="py-4" />
        ) : (
          <div className="space-y-1.5">
            {sorted.map(([key, count]) => {
              const pct = total > 0 ? (count / total) * 100 : 0;
              return (
                <div key={key} className="flex items-center gap-2 text-xs">
                  <span className="font-mono w-[140px] truncate" title={key}>{key}</span>
                  <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-foreground/20 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="tabular-nums text-muted-foreground w-[40px] text-right">{count}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Discrepancy Table ───────────────────────────────────────────────────────

function DiscrepancyTable({
  discrepancies, total, page, pageSize, onPageChange,
}: {
  discrepancies: EvalDiscrepancy[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const totalPages = Math.ceil(total / pageSize);

  const categoryColor: Record<string, string> = {
    false_positive: 'text-amber-600 dark:text-amber-400',
    false_negative: 'text-red-600 dark:text-red-400',
    action_mismatch: 'text-blue-600 dark:text-blue-400',
    strategy_mismatch: 'text-purple-600 dark:text-purple-400',
    direction_mismatch: 'text-teal-600 dark:text-teal-400',
  };

  const verdictColor: Record<string, string> = {
    parser_right: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    label_right: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    both_wrong: 'bg-red-500/10 text-red-700 dark:text-red-400',
  };

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[100px]">Category</TableHead>
            <TableHead className="w-[90px]">Author</TableHead>
            <TableHead>Message</TableHead>
            <TableHead className="w-[80px]">Parser</TableHead>
            <TableHead className="w-[80px]">Label</TableHead>
            <TableHead className="w-[90px]">Verdict</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {discrepancies.map(d => (
            <>
              <TableRow
                key={d.messageId}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => setExpanded(expanded === d.messageId ? null : d.messageId)}
              >
                <TableCell>
                  <span className={cn('text-xs font-medium', categoryColor[d.category])}>
                    {d.category.replace('_', ' ')}
                  </span>
                </TableCell>
                <TableCell className="text-xs">{d.author}</TableCell>
                <TableCell className="text-xs max-w-[400px] truncate" title={d.cleanText}>
                  {d.cleanText.slice(0, 80)}{d.cleanText.length > 80 ? '...' : ''}
                </TableCell>
                <TableCell>
                  <Badge label={d.parserAction ?? d.parserSkipReason ?? 'SKIP'} />
                </TableCell>
                <TableCell>
                  <Badge label={d.labelAction ?? 'SKIP'} />
                </TableCell>
                <TableCell>
                  {d.verdict ? (
                    <span className={cn('text-xs px-1.5 py-0.5 rounded', verdictColor[d.verdict])}>
                      {d.verdict.replace('_', ' ')}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">pending</span>
                  )}
                </TableCell>
              </TableRow>
              {expanded === d.messageId && (
                <TableRow key={`${d.messageId}-detail`}>
                  <TableCell colSpan={6} className="bg-muted/30 text-xs">
                    <div className="grid grid-cols-2 gap-4 py-2">
                      <div>
                        <p className="font-semibold mb-1">Full Message</p>
                        <p className="whitespace-pre-wrap text-muted-foreground">{d.cleanText}</p>
                        <div className="flex gap-1 mt-2">
                          {d.badges.map(b => <Badge key={b} label={b} />)}
                          {d.symbols.map(s => <span key={s} className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{s}</span>)}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div>
                          <p className="font-semibold">Parser</p>
                          <p>Action: {d.parserAction ?? 'null'} | Strategy: {d.parserStrategy ?? 'null'} | Dir: {d.parserDirection ?? 'null'}</p>
                          {d.parserSkipReason && <p>Skip: {d.parserSkipReason}</p>}
                          {d.parserFlags.length > 0 && <p>Flags: {d.parserFlags.join(', ')}</p>}
                        </div>
                        <div>
                          <p className="font-semibold">Label</p>
                          <p>Action: {d.labelAction ?? 'SKIP'} | Strategy: {d.labelStrategy ?? 'null'} | Dir: {d.labelDirection ?? 'null'}</p>
                          {d.labelNotes && <p className="text-muted-foreground">Notes: {d.labelNotes}</p>}
                        </div>
                        {d.verdictReason && (
                          <div>
                            <p className="font-semibold">Verdict Reason</p>
                            <p className="text-muted-foreground">{d.verdictReason}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </>
          ))}
        </TableBody>
      </Table>

      {/* Pagination */}
      <div className="flex items-center justify-between px-4 py-3 border-t">
        <span className="text-xs text-muted-foreground">
          {formatInteger(total)} total discrepancies
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() => onPageChange(Math.max(0, page - 1))}
            disabled={page === 0}
          >
            Prev
          </Button>
          <span className="text-xs px-2 py-1">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
