import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { EmptyState } from '@/components/empty-state';
import { formatCurrency, formatInteger, formatRMultiple } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DashboardTradeQualitySummary } from '@/lib/page-adapters';

type BucketRow = {
  label: string;
  count: number;
};

const GRADE_COLOR = {
  A: 'text-profit',
  B: 'text-info',
  C: 'text-warning',
  D: 'text-loss',
  F: 'text-destructive',
};

function BarRows({
  rows,
  max,
  valueClassName,
}: {
  rows: BucketRow[];
  max: number;
  valueClassName?: (row: BucketRow) => string;
}) {
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[52px_1fr_32px] items-center gap-2 text-[10px]">
          <span className="font-mono text-muted-foreground">{row.label}</span>
          <Progress
            value={max > 0 ? (row.count / max) * 100 : 0}
            className={cn('h-1.5 bg-muted/50', valueClassName?.(row))}
          />
          <span className="text-right font-mono tabular-nums text-muted-foreground">
            {formatInteger(row.count)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function QualitySnapshotPanel({ summary }: { summary: DashboardTradeQualitySummary }) {
  const { coverage } = summary;
  const finitePct = coverage.closedTrades > 0
    ? (coverage.withFiniteRisk / coverage.closedTrades) * 100
    : 0;
  const maxR = Math.max(...summary.rBuckets.map((bucket) => bucket.count), 1);
  const maxGrade = Math.max(...summary.gradeBuckets.map((bucket) => bucket.count), 1);
  const topFlags = summary.flagCounts.slice(0, 4);
  const topStrategy = summary.byStrategy[0];

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm">Trade Quality</CardTitle>
          <span className="font-mono text-[10px] text-muted-foreground">
            {formatInteger(coverage.withFiniteRisk)} / {formatInteger(coverage.closedTrades)} finite risk
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 py-3">
        {coverage.closedTrades === 0 ? (
          <EmptyState
            title="No closed trades yet"
            hint="R distribution appears after trades close with finite risk"
            className="py-5"
          />
        ) : (
          <>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Risk coverage</span>
                <span className="font-mono tabular-nums">
                  {finitePct.toFixed(0)}%
                  {coverage.excluded > 0 && (
                    <span className="ml-1 text-muted-foreground">
                      ({formatInteger(coverage.excluded)} excluded)
                    </span>
                  )}
                </span>
              </div>
              <Progress
                value={finitePct}
                className={cn('h-1.5', finitePct < 50 && '[&>div]:bg-warning')}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <section className="space-y-2">
                <h3 className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  R Distribution
                </h3>
                <BarRows
                  rows={summary.rBuckets}
                  max={maxR}
                  valueClassName={(row) => row.label.startsWith('-') || row.label.startsWith('<')
                    ? '[&>div]:bg-loss'
                    : '[&>div]:bg-profit'}
                />
              </section>

              <section className="space-y-2">
                <h3 className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  Grades
                </h3>
                <BarRows
                  rows={summary.gradeBuckets.map((bucket) => ({
                    label: bucket.grade,
                    count: bucket.count,
                  }))}
                  max={maxGrade}
                  valueClassName={(row) => cn(
                    row.label === 'A' && '[&>div]:bg-profit',
                    row.label === 'B' && '[&>div]:bg-info',
                    row.label === 'C' && '[&>div]:bg-warning',
                    (row.label === 'D' || row.label === 'F') && '[&>div]:bg-loss',
                  )}
                />
              </section>
            </div>

            <div className="grid grid-cols-1 gap-3 border-t border-border/40 pt-3 md:grid-cols-2">
              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  Top Strategy
                </p>
                {topStrategy ? (
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium">{topStrategy.strategy}</span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatCurrency(topStrategy.totalPnl, 0)} · {formatRMultiple(topStrategy.avgR)}
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">No strategy data</span>
                )}
              </div>

              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  Process Flags
                </p>
                {topFlags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {topFlags.map((row) => (
                      <span
                        key={row.flag}
                        className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {row.flag} {formatInteger(row.count)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">No quality flags</span>
                )}
              </div>
            </div>

            {summary.gradeBuckets.some((bucket) => bucket.count > 0) && (
              <div className="flex flex-wrap gap-2 border-t border-border/40 pt-3">
                {summary.gradeBuckets
                  .filter((bucket) => bucket.count > 0)
                  .map((bucket) => (
                    <span
                      key={bucket.grade}
                      className={cn('font-mono text-[10px] tabular-nums', GRADE_COLOR[bucket.grade])}
                    >
                      {bucket.grade}: {formatInteger(bucket.count)}
                    </span>
                  ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
