import type { Signal } from '@src/agent/schemas';

export const SIGNAL_FIELDS: (keyof Signal)[] = [
  'action', 'symbol', 'strategy', 'direction',
  'strikes', 'expiry', 'statedPrice', 'quantity',
  'exitPercent', 'targetStrategy',
];

// Raw equality only — labels and classifier signals are both canonicalized at
// write time via canonicalizeSignal() in src/eval/canonical-signal.ts.
export function fieldMatches(field: keyof Signal, a: unknown, b: unknown): boolean {
  if (field === 'strikes') {
    if (!Array.isArray(a) && !Array.isArray(b)) return a == null && b == null;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b || (a == null && b == null);
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
  for (const f of SIGNAL_FIELDS) {
    const lv = label[f];
    const cv = classifier[f];
    if (lv == null && cv == null) continue;
    if (fieldMatches(f, lv, cv)) matched++;
    else mismatched++;
  }
  return { totalFields: matched + mismatched, matchedFields: matched, mismatchedFields: mismatched };
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
