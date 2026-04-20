import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { SIGNAL_FIELDS, fieldMatches } from './diff-cell';
import type { Signal } from '@src/agent/schemas';
import type { EvalLabelData } from '@src/db/schema';
import type { ClassifyLabelRow } from '@src/local-api/http-schemas';

type FieldName = keyof Signal;

function displayValue(v: unknown): string {
  if (v == null) return '—';
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  return String(v);
}

function buildClassifierHumanLabel(
  base: EvalLabelData,
  classifierSignals: Signal[],
  classifierIsTrade: boolean,
): EvalLabelData {
  return {
    reasoning: base.reasoning,
    confidence: base.confidence,
    isTrade: classifierIsTrade,
    trades: classifierIsTrade && classifierSignals.length > 0 ? [classifierSignals] : [],
  };
}

function buildFieldPickHumanLabel(
  label: EvalLabelData,
  currentHumanLabel: EvalLabelData | null,
  field: FieldName,
  pick: 'label' | 'classifier',
  classifierSignal: Signal | null,
): EvalLabelData | null {
  const baseline = currentHumanLabel ?? label;
  const baselineSig = baseline.trades[0]?.[0];
  const labelSig = label.trades[0]?.[0];
  if (!baselineSig || !labelSig) return null;
  const pickedValue = pick === 'classifier' ? classifierSignal?.[field] : labelSig[field];
  const mergedSig = { ...baselineSig, [field]: pickedValue };
  const restLegs = baseline.trades[0]?.slice(1) ?? [];
  return {
    ...baseline,
    trades: [[mergedSig, ...restLegs]],
  };
}

function describeVerdict(label: ClassifyLabelRow): string {
  if (!label.humanVerified) return 'Not reviewed';
  if (!label.humanLabel) return 'Reviewed: label correct';
  const hl = label.humanLabel;
  const orig = label.label;
  if (hl.isTrade !== orig.isTrade) return 'Reviewed: classifier correct';
  const hlSig = hl.trades[0]?.[0];
  const lSig = orig.trades[0]?.[0];
  if (!hlSig || !lSig) return 'Reviewed: modified';
  let diff = 0;
  for (const f of SIGNAL_FIELDS) {
    if (!fieldMatches(f, hlSig[f], lSig[f])) diff++;
  }
  if (diff === 0) return 'Reviewed: label correct';
  return `Reviewed: ${diff} overridden`;
}

export function VerdictPanel({
  label,
  classifierSignals,
  runId,
}: {
  label: ClassifyLabelRow | undefined;
  classifierSignals: Signal[];
  runId: string;
}) {
  if (!label) {
    return <div className="text-xs text-muted-foreground italic">No label for this message.</div>;
  }
  return <VerdictPanelContent label={label} classifierSignals={classifierSignals} runId={runId} />;
}

function VerdictPanelContent({
  label,
  classifierSignals,
  runId,
}: {
  label: ClassifyLabelRow;
  classifierSignals: Signal[];
  runId: string;
}) {
  const invalidate = [['classify', runId]];

  const approveMut = useApiMutation('POST', `/eval/labels/${label.id}/approve`, {
    invalidate,
    onSuccess: () => toast.success('Label marked correct'),
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });
  const reviewMut = useApiMutation<{ humanLabel: EvalLabelData }>(
    'POST',
    `/eval/labels/${label.id}/review`,
    {
      invalidate,
      onSuccess: () => toast.success('Verdict updated'),
      onError: (e) => toast.error(`Failed: ${e.message}`),
    },
  );
  const undoMut = useApiMutation('POST', `/eval/labels/${label.id}/undo`, {
    invalidate,
    onSuccess: () => toast.success('Verdict cleared'),
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });

  const labelData = label.label;
  const humanLabel = label.humanLabel;
  const effective = humanLabel ?? labelData;

  const labelSignal = labelData.trades[0]?.[0] ?? null;
  const classifierSignal = classifierSignals[0] ?? null;
  const effectiveSignal = effective.trades[0]?.[0] ?? null;

  const classifierIsTrade = classifierSignals.length > 0;
  const busy = approveMut.isPending || reviewMut.isPending || undoMut.isPending;

  const pickField = (field: FieldName, pick: 'label' | 'classifier') => {
    const next = buildFieldPickHumanLabel(labelData, humanLabel, field, pick, classifierSignal);
    if (next) reviewMut.mutate({ humanLabel: next });
  };

  const markClassifierCorrect = () => {
    const next = buildClassifierHumanLabel(labelData, classifierSignals, classifierIsTrade);
    reviewMut.mutate({ humanLabel: next });
  };

  const canPerFieldPick = labelSignal != null && classifierSignal != null;

  const rows: { field: string; lv: string; cv: string; match: boolean; picker: boolean; winner: string }[] = [
    {
      field: 'isTrade',
      lv: String(labelData.isTrade),
      cv: String(classifierIsTrade),
      match: labelData.isTrade === classifierIsTrade,
      picker: false,
      winner: '',
    },
    ...SIGNAL_FIELDS.flatMap((f) => {
      const lv = labelSignal?.[f] ?? null;
      const cv = classifierSignal?.[f] ?? null;
      if (lv == null && cv == null) return [];
      const match = fieldMatches(f, lv, cv);
      const ev = effectiveSignal?.[f];
      const matchLabel = fieldMatches(f, ev, lv);
      const matchClassifier = fieldMatches(f, ev, cv);
      const winner = matchLabel ? 'label' : matchClassifier ? 'classifier' : '';
      return [{
        field: f as string,
        lv: displayValue(lv),
        cv: displayValue(cv),
        match,
        picker: canPerFieldPick && !match,
        winner,
      }];
    }),
  ];

  return (
    <div className="space-y-2 text-xs">
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.field} className={`flex items-center gap-2 ${!r.match ? 'bg-loss/10' : ''}`}>
            <span className="font-mono text-muted-foreground w-20 shrink-0">{r.field}</span>
            <span className="font-mono break-all flex-1 min-w-0">{r.lv}</span>
            <span className="font-mono break-all flex-1 min-w-0">{r.cv}</span>
            <span className="w-16 shrink-0 text-right">
              {r.picker ? (
                <ToggleGroup
                  type="single"
                  size="sm"
                  variant="outline"
                  value={r.winner}
                  onValueChange={(v) => {
                    if (v === 'label' || v === 'classifier') pickField(r.field as FieldName, v);
                  }}
                  disabled={busy}
                >
                  <ToggleGroupItem value="label" className="h-5 px-1.5 text-[10px]">L</ToggleGroupItem>
                  <ToggleGroupItem value="classifier" className="h-5 px-1.5 text-[10px]">C</ToggleGroupItem>
                </ToggleGroup>
              ) : r.match ? (
                <span className="text-profit">✓</span>
              ) : (
                <span className="text-muted-foreground/40">—</span>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{describeVerdict(label)}</span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button variant="outline" size="xs" disabled={busy} onClick={() => approveMut.mutate()}>
            Label correct
          </Button>
          <Button variant="outline" size="xs" disabled={busy} onClick={markClassifierCorrect}>
            Classifier correct
          </Button>
          {label.humanVerified && (
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => undoMut.mutate()}>
              Undo
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
