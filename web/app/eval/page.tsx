import { getLabels, getLabelStats, getEvalRuns } from '@/lib/queries';
import { MetricStrip } from '../components/metric-strip';
import type { Metric } from '../components/metric-strip';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { LabelActions } from './label-editor';
import { Badge } from '../components/badge';
import { AccuracyChart } from './accuracy-chart';
import type { DetectedStrategy } from '../../../src/db/schema';
import { pctDisplay } from '../../../src/lib/numbers';

export const dynamic = 'force-dynamic';

function pct(v: number | null): string {
  if (v == null) return '–';
  return pctDisplay(v);
}

/** Simple boolean mismatch: does anything obviously differ between parse hints and label? */
function hasMismatch(
  parseHints: { actionHint: string | null; directionHint: string | null; strategy: string | null; price: number | null; strikes: number[] | null; expiry: string | null; symbol: string | null },
  label: { action: string | null; direction: string | null; strategy: string | null; price: string | null; strikes: unknown; expiry: string | null; symbol: string | null },
): boolean {
  // Action: ADJUST (parse) has no label equivalent, ADD/TRIM (label) have no parse equivalent — skip when enums don't overlap
  const comparableActions = ['OPEN', 'CLOSE'];
  if (
    parseHints.actionHint && label.action &&
    comparableActions.includes(parseHints.actionHint) && comparableActions.includes(label.action) &&
    parseHints.actionHint !== label.action
  ) return true;

  if (parseHints.directionHint && label.direction && parseHints.directionHint !== label.direction) return true;
  if (parseHints.strategy && label.strategy && parseHints.strategy !== label.strategy) return true;
  if (parseHints.symbol && label.symbol && parseHints.symbol.toUpperCase() !== label.symbol.toUpperCase()) return true;

  if (parseHints.price != null && label.price) {
    if (String(parseHints.price) !== label.price) return true;
  }

  if (parseHints.expiry && label.expiry && parseHints.expiry !== label.expiry) return true;

  const parseStrikes = parseHints.strikes;
  const labelStrikes = label.strikes as number[] | null;
  if (parseStrikes && parseStrikes.length > 0 && labelStrikes && labelStrikes.length > 0) {
    if (parseStrikes.join(',') !== labelStrikes.join(',')) return true;
  }

  return false;
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

  function filterUrl(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    const merged = { reviewed: params.reviewed, strategy: params.strategy, ...overrides };
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== '') p.set(k, v);
    }
    return `/eval?${p.toString()}`;
  }

  // Build strategy counts, filtering out "null" key unless count > 0 (shown as "Unset")
  const strategyEntries: { key: string; label: string; count: number }[] = [];
  for (const [key, cnt] of Object.entries(stats.byStrategy)) {
    if (key === 'null') {
      if (cnt > 0) strategyEntries.push({ key: 'null', label: 'Unset', count: cnt });
    } else {
      strategyEntries.push({ key, label: key, count: cnt });
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Eval</h2>
      </div>

      {/* Stats MetricStrip — always visible */}
      <MetricStrip metrics={[
        { label: 'Total Labels', value: stats.total, format: 'integer' },
        { label: 'Reviewed', value: stats.total > 0 ? (stats.reviewed / stats.total) * 100 : 0, format: 'percent' },
        ...(latestRun ? [
          { label: 'Overall Accuracy', value: (latestRun.overallAccuracy ?? 0) * 100, format: 'percent' as const },
          { label: 'Action Accuracy', value: (latestRun.actionAccuracy ?? 0) * 100, format: 'percent' as const },
          { label: 'Direction Accuracy', value: (latestRun.directionAccuracy ?? 0) * 100, format: 'percent' as const },
        ] : []),
      ] satisfies Metric[]} />

      {/* Collapsed Eval History: chart + run table in one Accordion */}
      {evalRuns.length > 0 && (
        <Accordion type="single" collapsible>
          <AccordionItem value="eval-history">
            <AccordionTrigger className="text-sm font-semibold px-1">
              Eval History
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pt-2">
              {evalRuns.length >= 2 && (
                <Card>
                  <CardContent className="p-4">
                    <h3 className="text-sm font-semibold text-foreground mb-3">Accuracy Trend</h3>
                    <AccuracyChart evalRuns={evalRuns} />
                  </CardContent>
                </Card>
              )}
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
                              <span className={run.totalMislabelings && run.totalMislabelings > 0 ? 'text-loss font-medium' : 'text-profit'}>
                                {run.totalMislabelings ?? 0}
                              </span>
                            </TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.overallAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.actionAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.directionAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.strategyAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.priceAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">
                              <span className={run.exitPriceAccuracy != null && run.exitPriceAccuracy < 0.8 ? 'text-loss font-medium' : ''}>
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
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}

      {/* Filters with counts */}
      <div className="flex gap-2 flex-wrap">
        <Button variant={reviewedFilter === undefined ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link href={filterUrl({ reviewed: undefined, page: undefined })}>All ({stats.total})</Link>
        </Button>
        <Button variant={reviewedFilter === false ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link href={filterUrl({ reviewed: 'false', page: undefined })}>Unreviewed ({stats.unreviewed})</Link>
        </Button>
        <Button variant={reviewedFilter === true ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link href={filterUrl({ reviewed: 'true', page: undefined })}>Reviewed ({stats.reviewed})</Link>
        </Button>

        <span className="text-muted-foreground">|</span>

        <Button variant={!strategyFilter ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link href={filterUrl({ strategy: undefined, page: undefined })}>Any strategy</Link>
        </Button>
        {strategyEntries.map((s) => (
          <Button key={s.key} variant={strategyFilter === s.key ? 'secondary' : 'ghost'} size="sm" asChild>
            <Link href={filterUrl({ strategy: s.key, page: undefined })}>{s.label} ({s.count})</Link>
          </Button>
        ))}
      </div>

      {/* 3-column Table */}
      <Card className="py-0 gap-0 overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40%]">Message</TableHead>
                <TableHead>Label</TableHead>
                <TableHead className="w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ label, message }) => {
                const strategies = (message.detectedStrategies ?? []) as DetectedStrategy[];
                const topStrat = strategies[0];

                const symbols = (message.symbols ?? []) as string[];
                const parseHints = {
                  actionHint: message.actionHint,
                  directionHint: message.directionHint,
                  strategy: topStrat?.strategy ?? null,
                  price: topStrat?.price ?? null,
                  strikes: topStrat?.strikes ?? null,
                  expiry: topStrat?.expiry ?? null,
                  symbol: symbols[0] ?? null,
                };

                const mismatch = hasMismatch(parseHints, label);

                return (
                  <TableRow
                    key={label.id}
                    className={`align-top ${!label.reviewed ? 'bg-warning/5' : ''}`}
                  >
                    {/* Message column */}
                    <TableCell className="text-xs max-w-[400px]">
                      <div className="text-muted-foreground text-[11px]">
                        {message.author} &middot; {new Date(message.timestamp).toLocaleDateString()}
                      </div>
                      <div className="line-clamp-2 mt-0.5 leading-relaxed" title={message.cleanText}>
                        {message.cleanText}
                      </div>
                    </TableCell>

                    {/* Label column: badges + details */}
                    <TableCell className="text-xs">
                      <div className="flex items-center gap-1 flex-wrap">
                        {label.isTrade === false && <Badge label="NOT TRADE" />}
                        {label.action && <Badge label={label.action} />}
                        {label.direction && <Badge label={label.direction} />}
                        {label.strategy && <Badge label={label.strategy} />}
                        {label.symbol && (
                          <span className="font-semibold text-foreground">{label.symbol}</span>
                        )}
                        {label.price && (
                          <span className="text-muted-foreground">${label.price}</span>
                        )}
                        {mismatch && (
                          <TriangleAlert className="h-3.5 w-3.5 text-warning shrink-0" />
                        )}
                      </div>
                      {/* Secondary line: strikes, expiry, quantity */}
                      {(label.strikes || label.expiry || label.quantity) && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {label.strikes && `K: ${(label.strikes as number[]).join(', ')}`}
                          {label.strikes && label.expiry && ' · '}
                          {label.expiry && `Exp: ${label.expiry}`}
                          {(label.strikes || label.expiry) && label.quantity && ' · '}
                          {label.quantity && `Qty: ${label.quantity}`}
                        </div>
                      )}
                    </TableCell>

                    {/* Actions column */}
                    <TableCell>
                      <LabelActions
                        label={{
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
                          exitPercent: label.exitPercent ?? null,
                          notes: label.notes,
                          reviewed: label.reviewed,
                        }}
                        message={{
                          author: message.author,
                          timestamp: message.timestamp,
                          cleanText: message.cleanText,
                        }}
                        parseHints={parseHints}
                      />
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
