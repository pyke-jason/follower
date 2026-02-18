'use client';

import { forwardRef, useCallback } from 'react';
import { TableVirtuoso } from 'react-virtuoso';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type { AccuracyResult, Failure, FieldName } from '../../../src/lib/eval';

const FIELD_LABELS: Record<FieldName, string> = {
  isTrade: 'Is Trade',
  action: 'Action',
  direction: 'Direction',
  strategy: 'Strategy',
  symbol: 'Symbol',
  price: 'Price',
  strikes: 'Strikes',
};

function pct(v: number | null): string {
  if (v === null) return 'N/A';
  return (v * 100).toFixed(1) + '%';
}

function colorClass(v: number | null): string {
  if (v === null) return 'text-muted-foreground';
  if (v >= 0.95) return 'text-emerald-600';
  if (v >= 0.80) return 'text-amber-600';
  return 'text-red-600';
}

const thClass =
  'text-muted-foreground h-9 px-4 text-left align-middle text-[11px] font-medium uppercase tracking-wider whitespace-nowrap';
const trClass = 'border-b transition-colors';

const virtuosoComponents = {
  Table: ({ style, ...props }: React.ComponentProps<'table'> & { style?: React.CSSProperties }) => (
    <table style={{ ...style, tableLayout: 'fixed' }} className="w-full caption-bottom text-sm" {...props} />
  ),
  TableHead: forwardRef<HTMLTableSectionElement, React.ComponentProps<'thead'>>(
    (props, ref) => <thead ref={ref} className="[&_tr]:border-b bg-card sticky top-0 z-10" {...props} />,
  ),
  TableBody: forwardRef<HTMLTableSectionElement, React.ComponentProps<'tbody'>>(
    (props, ref) => <tbody ref={ref} className="[&_tr:last-child]:border-0" {...props} />,
  ),
  TableRow: ({ style, ...props }: React.ComponentProps<'tr'> & { style?: React.CSSProperties }) => (
    <tr style={style} className={trClass} {...props} />
  ),
};

export function AccuracyGrid({
  result,
  totalMessages,
  labeledMessages,
}: {
  result: AccuracyResult;
  totalMessages?: number;
  labeledMessages?: number;
}) {
  return (
    <div className="space-y-4">
      {/* Header metrics */}
      <div className="flex items-baseline gap-6 flex-wrap">
        <div>
          <span className="text-xs text-muted-foreground">Overall Accuracy</span>
          <p className={`text-2xl font-semibold tabular-nums ${colorClass(result.overallAccuracy)}`}>
            {pct(result.overallAccuracy)}
          </p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Labeled</span>
          <p className="text-2xl font-semibold tabular-nums">
            {result.totalLabels}
            {totalMessages != null && (
              <span className="text-sm text-muted-foreground font-normal"> / {totalMessages} msgs</span>
            )}
          </p>
        </div>
        {result.failures.length > 0 && (
          <div>
            <span className="text-xs text-muted-foreground">Mismatches</span>
            <p className="text-2xl font-semibold tabular-nums text-red-600">{result.failures.length}</p>
          </div>
        )}
      </div>

      {/* Per-field accuracy cards */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
        {(Object.keys(FIELD_LABELS) as FieldName[]).map((field) => {
          const f = result.fields[field];
          return (
            <Card key={field} className="py-0 gap-0">
              <CardContent className="p-3">
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-xs text-muted-foreground">{FIELD_LABELS[field]}</span>
                  <span className={`text-sm font-medium tabular-nums ${colorClass(f.accuracy)}`}>
                    {pct(f.accuracy)}
                  </span>
                </div>
                <Progress value={f.accuracy != null ? f.accuracy * 100 : 0} className="h-1.5" />
                <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
                  {f.correct}/{f.total}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Failures table — virtualized */}
      {result.failures.length > 0 && (
        <Card className="py-0 gap-0 overflow-hidden flex flex-col" style={{ height: Math.min(result.failures.length * 36 + 52, 500) }}>
          <CardHeader className="border-b py-3 px-4 shrink-0">
            <CardTitle className="text-sm">
              Mismatches
              <span className="text-muted-foreground font-normal"> ({result.failures.length})</span>
            </CardTitle>
          </CardHeader>
          <div className="flex-1 min-h-0">
            <TableVirtuoso
              style={{ height: '100%' }}
              data={result.failures}
              overscan={200}
              components={virtuosoComponents}
              fixedHeaderContent={() => (
                <tr className={trClass + ' bg-card'}>
                  <th className={thClass} style={{ width: '40%' }}>Message</th>
                  <th className={thClass} style={{ width: 100 }}>Field</th>
                  <th className={thClass} style={{ width: 120 }}>Expected</th>
                  <th className={thClass} style={{ width: 120 }}>Got</th>
                </tr>
              )}
              itemContent={useCallback((_index: number, f: Failure) => (
                <>
                  <td className="px-4 py-2 text-xs text-muted-foreground truncate max-w-[300px]">
                    {f.cleanText}
                  </td>
                  <td className="px-4 py-2 text-xs font-medium">{f.field}</td>
                  <td className="px-4 py-2 text-xs font-mono">{f.expected}</td>
                  <td className="px-4 py-2 text-xs font-mono text-red-600">{f.got}</td>
                </>
              ), [])}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
