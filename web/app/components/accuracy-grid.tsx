import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AccuracyResult, FieldName } from '@/lib/eval-helpers';

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

export function AccuracyGrid({
  result,
  totalMessages,
  labeledMessages,
  maxFailures = 20,
}: {
  result: AccuracyResult;
  totalMessages?: number;
  labeledMessages?: number;
  maxFailures?: number;
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

      {/* Failures table */}
      {result.failures.length > 0 && (
        <Card className="py-0 gap-0 overflow-hidden">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">
              Mismatches
              {result.failures.length > maxFailures && (
                <span className="text-muted-foreground font-normal"> (showing {maxFailures} of {result.failures.length})</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40%]">Message</TableHead>
                  <TableHead>Field</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead>Got</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.failures.slice(0, maxFailures).map((f, i) => (
                  <TableRow key={i}>
                    <td className="px-4 py-2 text-xs text-muted-foreground truncate max-w-[300px]">
                      {f.cleanText}
                    </td>
                    <td className="px-4 py-2 text-xs font-medium">{f.field}</td>
                    <td className="px-4 py-2 text-xs font-mono">{f.expected}</td>
                    <td className="px-4 py-2 text-xs font-mono text-red-600">{f.got}</td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
