import { Badge } from '@/components/ui/badge';
import type { EvalSummary } from '@/lib/api-types';

export function EvalAccuracyStrip({ summary }: { summary: NonNullable<EvalSummary> }) {
  const total = summary.labeled + summary.unlabeled;
  const labelPct = total > 0 ? summary.labeled / total : 0;
  const unlabeledPct = total > 0 ? summary.unlabeled / total : 0;
  const isHighUnlabeled = unlabeledPct > 0.2;

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg border bg-card text-sm flex-wrap">
      <LabeledMetric
        label="Labels"
        value={`${summary.labeled}/${total} (${(labelPct * 100).toFixed(0)}%)`}
      />
      <Separator />
      <LabeledMetric
        label="Accuracy"
        value={`${(summary.metrics.accuracy * 100).toFixed(0)}%`}
      />
      <Separator />
      <LabeledMetric
        label="Precision"
        value={`${(summary.metrics.precision * 100).toFixed(0)}%`}
      />
      <Separator />
      <LabeledMetric
        label="Recall"
        value={`${(summary.metrics.recall * 100).toFixed(0)}%`}
      />
      <Separator />
      <LabeledMetric
        label="F1"
        value={summary.metrics.f1.toFixed(2)}
      />
      {summary.unlabeled > 0 && (
        <>
          <Separator />
          <Badge variant={isHighUnlabeled ? 'destructive' : 'secondary'} className={!isHighUnlabeled ? 'bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400' : ''}>
            {summary.unlabeled} unlabeled
          </Badge>
        </>
      )}
    </div>
  );
}

function LabeledMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-semibold tabular-nums">{value}</span>
    </span>
  );
}

function Separator() {
  return <span className="text-border">|</span>;
}
