import type { Signal } from '@src/agent/schemas';
import { cn } from '@/lib/utils';

const FIELDS: (keyof Signal)[] = [
  'action', 'symbol', 'strategy', 'direction',
  'strikes', 'expiry', 'statedPrice', 'quantity',
  'exitPercent', 'targetStrategy',
];

// Raw equality only — labels and classifier signals are both canonicalized at
// write time via canonicalizeSignal() in src/eval/canonical-signal.ts. If this
// component needs to normalize anything, the bug is in the write path.
function fieldMatches(field: keyof Signal, a: unknown, b: unknown): boolean {
  if (field === 'strikes') {
    if (!Array.isArray(a) && !Array.isArray(b)) return a == null && b == null;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b || (a == null && b == null);
}

function displayValue(v: unknown): string {
  if (v == null) return '—';
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  return String(v);
}

type DiffResult = {
  totalFields: number;
  matchedFields: number;
  mismatchedFields: number;
};

/** Compute a summary count for table display. */
export function computeDiffSummary(label: Signal | null, classifier: Signal | null): DiffResult | null {
  if (!label && !classifier) return null;
  if (!label || !classifier) return null;
  let matched = 0;
  let mismatched = 0;
  for (const f of FIELDS) {
    const lv = label[f];
    const cv = classifier[f];
    if (lv == null && cv == null) continue;
    if (fieldMatches(f, lv, cv)) matched++;
    else mismatched++;
  }
  return { totalFields: matched + mismatched, matchedFields: matched, mismatchedFields: mismatched };
}

export function FieldDiffTable({ label, classifier }: {
  label: Signal | null;
  classifier: Signal | null;
}) {
  return (
    <div className="rounded border bg-muted/20 text-[11px]">
      <div className="grid grid-cols-[90px_1fr_1fr_24px] bg-muted/40 px-2 py-1 font-medium text-muted-foreground uppercase tracking-wider text-[10px]">
        <div>Field</div>
        <div>Label</div>
        <div>Classifier</div>
        <div></div>
      </div>
      {FIELDS.map((f) => {
        const lv = label?.[f] ?? null;
        const cv = classifier?.[f] ?? null;
        if (lv == null && cv == null) return null;
        const match = fieldMatches(f, lv, cv);
        return (
          <div
            key={f}
            className={cn(
              'grid grid-cols-[90px_1fr_1fr_24px] px-2 py-1 border-t border-border/30',
              !match && 'bg-loss/10',
            )}
          >
            <div className="font-mono text-muted-foreground">{f}</div>
            <div className="font-mono break-all">{displayValue(lv)}</div>
            <div className="font-mono break-all">{displayValue(cv)}</div>
            <div className={cn('font-mono text-center', match ? 'text-profit' : 'text-loss')}>
              {match ? '✓' : '✗'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DiffSummaryBadge({ summary, labelIsTrade, classifierIsTrade }: {
  summary: DiffResult | null;
  labelIsTrade: boolean | null;
  classifierIsTrade: boolean;
}) {
  if (labelIsTrade == null) {
    return <span className="text-muted-foreground/50 text-xs">unlabeled</span>;
  }
  if (!labelIsTrade && !classifierIsTrade) {
    return <span className="text-muted-foreground text-xs">both SKIP</span>;
  }
  if (labelIsTrade !== classifierIsTrade) {
    return <span className="text-loss text-xs font-mono">isTrade ✗</span>;
  }
  if (!summary) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  if (summary.mismatchedFields === 0) {
    return <span className="text-profit text-xs font-mono">all ✓</span>;
  }
  return (
    <span className="text-loss text-xs font-mono">
      {summary.mismatchedFields}/{summary.totalFields} ✗
    </span>
  );
}
