import { getLabels, getLabelStats, getEvalRuns } from '@/lib/queries';
import { MetricStrip } from '../components/metric-strip';
import type { Metric } from '../components/metric-strip';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { LabelEditor } from './label-editor';
import { AccuracyChart } from './accuracy-chart';
import type { DetectedStrategy } from '../../../src/db/schema';
import { pctDisplay } from '../../../src/lib/numbers';

export const dynamic = 'force-dynamic';

function pct(v: number | null): string {
  if (v == null) return '–';
  return pctDisplay(v);
}

export default async function EvalPage({
  searchParams,
}: {
  searchParams: Promise<{ reviewed?: string; strategy?: string; page?: string }>;
}) {
  const params = await searchParams;
  const reviewedFilter = params.reviewed === 'true' ? true : params.reviewed === 'false' ? false : undefined;
  const strategyFilter = params.strategy || undefined;
  const page = parseInt(params.page ?? '1');
  const limit = 50;
  const offset = (page - 1) * limit;

  const [rows, stats, evalRuns] = await Promise.all([
    getLabels({ reviewed: reviewedFilter, strategy: strategyFilter, limit, offset }),
    getLabelStats(),
    getEvalRuns({ limit: 50 }),
  ]);

  const latestRun = evalRuns.length > 0 ? evalRuns[evalRuns.length - 1] : null;

  // Build filter URL helper
  function filterUrl(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    const merged = { reviewed: params.reviewed, strategy: params.strategy, ...overrides };
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== '') p.set(k, v);
    }
    return `/eval?${p.toString()}`;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Eval</h2>
      </div>

      {/* Stats MetricStrip */}
      <MetricStrip metrics={[
        { label: 'Total Labels', value: stats.total, format: 'integer' },
        { label: 'Reviewed', value: stats.total > 0 ? (stats.reviewed / stats.total) * 100 : 0, format: 'percent' },
        ...(latestRun ? [
          { label: 'Overall Accuracy', value: (latestRun.overallAccuracy ?? 0) * 100, format: 'percent' as const },
          { label: 'Action Accuracy', value: (latestRun.actionAccuracy ?? 0) * 100, format: 'percent' as const },
          { label: 'Direction Accuracy', value: (latestRun.directionAccuracy ?? 0) * 100, format: 'percent' as const },
        ] : []),
      ] satisfies Metric[]} />

      {/* Accuracy Trend Chart */}
      {evalRuns.length >= 2 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold text-foreground mb-3">Accuracy Trend</h3>
            <AccuracyChart evalRuns={evalRuns} />
          </CardContent>
        </Card>
      )}

      {/* Eval Runs Trend */}
      {evalRuns.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold text-foreground mb-3">Eval Run History</h3>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Labels</TableHead>
                    <TableHead className="text-right">Mislabelings</TableHead>
                    <TableHead className="text-right">Overall</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                    <TableHead className="text-right">Direction</TableHead>
                    <TableHead className="text-right">Strategy</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Exit Price</TableHead>
                    <TableHead className="text-right">Strikes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {evalRuns.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="text-xs font-mono">
                        {new Date(run.ranAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{run.totalLabels}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        <span className={run.totalMislabelings && run.totalMislabelings > 0 ? 'text-red-500 font-medium' : 'text-green-500'}>
                          {run.totalMislabelings ?? 0}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{pct(run.overallAccuracy)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{pct(run.actionAccuracy)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{pct(run.directionAccuracy)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{pct(run.strategyAccuracy)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{pct(run.priceAccuracy)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        <span className={run.exitPriceAccuracy != null && run.exitPriceAccuracy < 0.8 ? 'text-red-500 font-medium' : ''}>
                          {pct(run.exitPriceAccuracy)}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{pct(run.strikesAccuracy)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {evalRuns.length >= 2 && (
              <div className="mt-3 text-xs text-muted-foreground">
                Mislabeling trend: {evalRuns[0].totalMislabelings ?? 0} → {evalRuns[evalRuns.length - 1].totalMislabelings ?? 0}
                {(evalRuns[evalRuns.length - 1].totalMislabelings ?? 0) < (evalRuns[0].totalMislabelings ?? 0)
                  ? ' (improving)'
                  : (evalRuns[evalRuns.length - 1].totalMislabelings ?? 0) === (evalRuns[0].totalMislabelings ?? 0)
                    ? ' (stable)'
                    : ' (regressing)'}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <Button variant={reviewedFilter === undefined ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link href={filterUrl({ reviewed: undefined, page: undefined })}>All</Link>
        </Button>
        <Button variant={reviewedFilter === false ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link href={filterUrl({ reviewed: 'false', page: undefined })}>Unreviewed</Link>
        </Button>
        <Button variant={reviewedFilter === true ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link href={filterUrl({ reviewed: 'true', page: undefined })}>Reviewed</Link>
        </Button>

        <span className="text-muted-foreground">|</span>

        <Button variant={!strategyFilter ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link href={filterUrl({ strategy: undefined, page: undefined })}>Any strategy</Link>
        </Button>
        {['STOCK', 'CALL', 'PUT', 'CDS', 'PDS'].map((s) => (
          <Button key={s} variant={strategyFilter === s ? 'secondary' : 'ghost'} size="sm" asChild>
            <Link href={filterUrl({ strategy: s, page: undefined })}>{s}</Link>
          </Button>
        ))}
      </div>

      {/* Table */}
      <Card className="py-0 gap-0 overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[300px]">Message</TableHead>
                <TableHead>Parse Output</TableHead>
                <TableHead>Label</TableHead>
                <TableHead className="w-[60px]">Status</TableHead>
                <TableHead className="w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ label, message }) => {
                const strategies = (message.detectedStrategies ?? []) as DetectedStrategy[];
                const topStrat = strategies[0];

                return (
                  <TableRow key={label.id} className="align-top">
                    <TableCell className="text-xs max-w-[300px]">
                      <div className="truncate font-medium" title={message.cleanText}>
                        {message.cleanText.slice(0, 80)}
                      </div>
                      <div className="text-muted-foreground mt-0.5">
                        {message.author} &middot; {new Date(message.timestamp).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="space-y-0.5">
                        <div>{message.actionHint ?? '–'} {message.directionHint ?? '–'}</div>
                        <div>{topStrat?.strategy ?? '–'} {topStrat?.price != null ? `$${topStrat.price}` : ''}</div>
                        {topStrat?.strikes && <div>K: {topStrat.strikes.join(', ')}</div>}
                        {topStrat?.expiry && <div>Exp: {topStrat.expiry}</div>}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="space-y-0.5">
                        <div>{label.action ?? '–'} {label.direction ?? '–'}</div>
                        <div>{label.strategy ?? '–'} {label.price ? `$${label.price}` : ''}</div>
                        {label.strikes && <div>K: {(label.strikes as number[]).join(', ')}</div>}
                        {label.expiry && <div>Exp: {label.expiry}</div>}
                        {label.symbol && <div className="font-medium">{label.symbol}</div>}
                      </div>
                    </TableCell>
                    <TableCell>
                      {label.reviewed ? (
                        <Badge variant="secondary" className="text-xs">Reviewed</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">Pending</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <LabelEditor label={{
                        id: label.id,
                        isTrade: label.isTrade,
                        action: label.action,
                        direction: label.direction,
                        strategy: label.strategy,
                        symbol: label.symbol,
                        price: label.price,
                        strikes: label.strikes as number[] | null,
                        quantity: label.quantity,
                        expiry: label.expiry,
                        notes: label.notes,
                        reviewed: label.reviewed,
                      }} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {rows.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No labels found. Run <code>npm run label</code> to auto-label messages.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex gap-2 justify-center items-center">
        {page > 1 && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={filterUrl({ page: String(page - 1) })}>Previous</Link>
          </Button>
        )}
        <span className="text-sm text-muted-foreground">Page {page}</span>
        {rows.length === limit && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={filterUrl({ page: String(page + 1) })}>Next</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
