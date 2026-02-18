import { getLabelStats, getEvalRuns } from '@/lib/queries';
import { MetricStrip } from '../components/metric-strip';
import type { Metric } from '../components/metric-strip';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { AccuracyChart } from './accuracy-chart';
import { pctDisplay } from '../../../src/lib/numbers';

export const dynamic = 'force-dynamic';

function pct(v: number | null): string {
  if (v == null) return '–';
  return pctDisplay(v);
}

export default async function EvalPage() {
  const [stats, evalRuns] = await Promise.all([
    getLabelStats(),
    getEvalRuns({ limit: 50 }),
  ]);

  const latestRun = evalRuns.length > 0 ? evalRuns[evalRuns.length - 1] : null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Eval Dashboard</h2>
        <p className="text-xs text-muted-foreground">
          Labels are created by approving/editing intents in the chat view.
          Run <code className="bg-muted px-1 rounded">npm run eval</code> to compare intents vs labels.
        </p>
      </div>

      {/* Stats */}
      <MetricStrip metrics={[
        { label: 'Total Labels', value: stats.total, format: 'integer' },
        { label: 'Reviewed', value: stats.total > 0 ? (stats.reviewed / stats.total) * 100 : 0, format: 'percent' },
        ...(latestRun ? [
          { label: 'Overall', value: (latestRun.overallAccuracy ?? 0) * 100, format: 'percent' as const },
          { label: 'isTrade', value: ((latestRun as any).isTradeAccuracy ?? 0) * 100, format: 'percent' as const },
          { label: 'Action', value: (latestRun.actionAccuracy ?? 0) * 100, format: 'percent' as const },
          { label: 'Direction', value: (latestRun.directionAccuracy ?? 0) * 100, format: 'percent' as const },
        ] : []),
      ] satisfies Metric[]} />

      {/* Label breakdown by strategy */}
      {stats.total > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold text-foreground mb-3">Labels by Strategy</h3>
            <div className="flex gap-3 flex-wrap">
              {Object.entries(stats.byStrategy).map(([strategy, count]) => (
                <div key={strategy} className="text-xs px-2.5 py-1.5 rounded-md bg-muted">
                  <span className="font-medium">{strategy === 'null' ? 'Unset' : strategy}</span>
                  <span className="text-muted-foreground ml-1.5">{count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Eval History */}
      {evalRuns.length > 0 && (
        <Accordion type="single" collapsible defaultValue="eval-history">
          <AccordionItem value="eval-history">
            <AccordionTrigger className="text-sm font-semibold px-1">
              Eval History ({evalRuns.length} runs)
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
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Model</TableHead>
                          <TableHead className="text-right">Labels</TableHead>
                          <TableHead className="text-right">Errors</TableHead>
                          <TableHead className="text-right">Overall</TableHead>
                          <TableHead className="text-right">isTrade</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                          <TableHead className="text-right">Direction</TableHead>
                          <TableHead className="text-right">Strategy</TableHead>
                          <TableHead className="text-right">Symbol</TableHead>
                          <TableHead className="text-right">Price</TableHead>
                          <TableHead className="text-right">Strikes</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {evalRuns.map((run) => (
                          <TableRow key={run.id}>
                            <TableCell className="text-xs font-mono">
                              {new Date(run.ranAt).toLocaleDateString()}
                            </TableCell>
                            <TableCell className="text-xs font-mono text-muted-foreground">
                              {(run as any).intentModel ?? '–'}
                              {(run as any).intentVersion != null && ` v${(run as any).intentVersion}`}
                            </TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{run.totalLabels}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">
                              <span className={run.totalMislabelings && run.totalMislabelings > 0 ? 'text-loss font-medium' : 'text-profit'}>
                                {run.totalMislabelings ?? 0}
                              </span>
                            </TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.overallAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct((run as any).isTradeAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.actionAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.directionAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.strategyAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct((run as any).symbolAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.priceAccuracy)}</TableCell>
                            <TableCell className="text-xs text-right tabular-nums">{pct(run.strikesAccuracy)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}

      {evalRuns.length === 0 && stats.total === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No labels yet. Go to the <a href="/messages" className="underline">Messages</a> page
              and use the checkmark/pencil buttons on intent strips to start labeling.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
