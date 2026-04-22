import { useState } from 'react';
import { CircleCheck, XCircle, AlertTriangle } from 'lucide-react';
import { Badge as UiBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTradesStore } from '@/stores/trades-store';
import type { RunDecision, Trade } from '@src/db/schema';
import type { TradeLabel } from '@src/local-api/http-schemas';
import { formatLegsSummary } from '@src/lib/trade';

export function TradeLabelSection({
  label,
  trade,
  systemDecision,
}: {
  label: TradeLabel | undefined;
  trade: Trade;
  systemDecision: RunDecision | null;
}) {
  if (!label || label.bucket === 'unlabeled') {
    return (
      <section>
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3 text-warning" />
          <span className="text-xs font-medium text-warning">No label</span>
        </div>
      </section>
    );
  }

  const mismatches = label.match?.mismatches ?? [];
  const isMatch = label.bucket === 'tp' && mismatches.length === 0;
  const isFalsePositive = label.bucket === 'fp';

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-1.5">
        {isFalsePositive ? (
          <>
            <XCircle className="h-3 w-3 text-destructive" />
            <span className="text-xs font-medium text-destructive">False positive</span>
          </>
        ) : isMatch ? (
          <>
            <CircleCheck className="h-3 w-3 text-profit" />
            <span className="text-xs font-medium text-profit">Match</span>
          </>
        ) : (
          <>
            <CircleCheck className="h-3 w-3 text-profit" />
            <span className="text-xs font-medium text-warning">
              {mismatches.length} diff{mismatches.length !== 1 ? 's' : ''}
            </span>
          </>
        )}
        {label.labelConfidence === 'LOW' && (
          <UiBadge variant="outline" className="h-4 px-1 text-[9px]">
            LOW
          </UiBadge>
        )}
      </div>

      {(label.labelReasoning || systemDecision?.reasoning) && (
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Label reasoning
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {label.labelReasoning ?? '—'}
            </p>
          </div>
          <div>
            <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              System reasoning
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {systemDecision?.reasoning ?? '—'}
            </p>
          </div>
        </div>
      )}

      <LabelDiffTable label={label} trade={trade} mismatches={mismatches} />

      {label.labelId && (
        <LabelVerdict
          labelId={label.labelId}
          humanVerified={label.humanVerified}
          rejectionReason={label.rejectionReason}
        />
      )}
    </section>
  );
}

function LabelVerdict({
  labelId,
  humanVerified,
  rejectionReason,
}: {
  labelId: string;
  humanVerified: boolean;
  rejectionReason: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const tradeId = useTradesStore((s) => s.selectedTradeId);
  const updateLabel = useTradesStore((s) => s.updateLabel);

  const currentVerdict = humanVerified ? (rejectionReason ?? 'LABEL_CORRECT') : null;

  const submit = async (action: 'approve' | 'reject', reason?: string) => {
    setLoading(true);
    try {
      const url = `/api/eval/labels/${labelId}/${action}`;
      const body = action === 'reject' ? JSON.stringify({ reason }) : undefined;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (tradeId) {
        updateLabel(tradeId, {
          humanVerified: true,
          rejectionReason: action === 'reject' ? (reason ?? null) : null,
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const undo = async () => {
    setLoading(true);
    try {
      await fetch(`/api/eval/labels/${labelId}/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (tradeId) {
        updateLabel(tradeId, { humanVerified: false, rejectionReason: null });
      }
    } finally {
      setLoading(false);
    }
  };

  const verdictLabels: Record<string, string> = {
    LABEL_CORRECT: 'Label correct',
    SYSTEM_CORRECT: 'System correct',
    BOTH_WRONG: 'Both wrong',
  };

  if (currentVerdict) {
    return (
      <div className="mt-3 flex items-center gap-2 border-t pt-2">
        <UiBadge variant="secondary" className="text-[10px]">
          {verdictLabels[currentVerdict] ?? currentVerdict}
        </UiBadge>
        <Button
          variant="ghost"
          size="xs"
          className="h-5 text-[10px] text-muted-foreground"
          disabled={loading}
          onClick={undo}
        >
          Undo
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 flex gap-1.5 border-t pt-2">
      <Button
        variant="outline"
        size="xs"
        className="h-6 text-[10px]"
        disabled={loading}
        onClick={() => submit('approve')}
      >
        Label correct
      </Button>
      <Button
        variant="outline"
        size="xs"
        className="h-6 text-[10px]"
        disabled={loading}
        onClick={() => submit('reject', 'SYSTEM_CORRECT')}
      >
        System correct
      </Button>
      <Button
        variant="outline"
        size="xs"
        className="h-6 text-[10px]"
        disabled={loading}
        onClick={() => submit('reject', 'BOTH_WRONG')}
      >
        Both wrong
      </Button>
    </div>
  );
}

function LabelDiffTable({
  label,
  trade,
  mismatches,
}: {
  label: TradeLabel;
  trade: Trade;
  mismatches: { path: string; expected: string; got: string }[];
}) {
  const mismatchMap = new Map(mismatches.map((m) => [m.path, m]));
  const signal = label.labelSignals?.[0] ?? null;
  const legsSummary = formatLegsSummary(trade.legs, trade.strategy);

  const tradeFields: {
    field: string;
    system: string;
    labelVal: string | null;
    match: boolean;
  }[] = [
    {
      field: 'isTrade',
      system: 'true',
      labelVal: label.labelIsTrade != null ? String(label.labelIsTrade) : null,
      match: label.labelIsTrade === true,
    },
    {
      field: 'action',
      system: signal
        ? (mismatchMap.get('action')?.got ?? String(signal.action ?? '—'))
        : (trade.status === 'CANCELLED' ? 'CANCELLED' : 'OPEN'),
      labelVal: signal ? String(signal.action ?? '—') : null,
      match: !mismatchMap.has('action'),
    },
    {
      field: 'symbol',
      system: trade.symbol,
      labelVal: signal ? String(signal.symbol ?? '—') : null,
      match: !mismatchMap.has('symbol'),
    },
    {
      field: 'direction',
      system: trade.direction,
      labelVal: signal ? String(signal.direction ?? 'null') : null,
      match: !mismatchMap.has('direction'),
    },
    {
      field: 'strategy',
      system: trade.strategy,
      labelVal: signal ? String(signal.strategy ?? 'null') : null,
      match: !mismatchMap.has('strategy'),
    },
  ];

  if (legsSummary) {
    tradeFields.push({
      field: 'strikes',
      system: legsSummary,
      labelVal: signal?.strikes ? JSON.stringify(signal.strikes) : null,
      match: true,
    });
  }

  const tradeExpiry = trade.legs?.find((leg: { expiry?: string }) => leg.expiry)?.expiry;
  if (tradeExpiry || signal?.expiry) {
    tradeFields.push({
      field: 'expiry',
      system: tradeExpiry ?? '—',
      labelVal: signal?.expiry ? String(signal.expiry) : null,
      match: true,
    });
  }

  if (trade.entryPrice || (signal && signal.statedPrice != null)) {
    tradeFields.push({
      field: 'price',
      system: trade.entryPrice ?? '—',
      labelVal: signal && signal.statedPrice != null ? String(signal.statedPrice) : null,
      match: true,
    });
  }

  if (trade.quantity || (signal && signal.quantity != null)) {
    tradeFields.push({
      field: 'quantity',
      system: String(trade.quantity ?? '—'),
      labelVal: signal && signal.quantity != null ? String(signal.quantity) : null,
      match: true,
    });
  }

  return (
    <div className="overflow-hidden rounded-md border text-xs">
      <div className="grid grid-cols-[72px_1fr_1fr] border-b bg-muted/50">
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Field
        </div>
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Label
        </div>
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          System
        </div>
      </div>
      {tradeFields.map((row) => (
        <div
          key={row.field}
          className={cn(
            'grid grid-cols-[72px_1fr_1fr] border-b last:border-b-0',
            !row.match && 'bg-destructive/5',
          )}
        >
          <div className="px-2 py-1 font-mono text-muted-foreground">{row.field}</div>
          <div
            className={cn(
              'px-2 py-1',
              row.labelVal == null ? 'text-muted-foreground/40' : 'font-medium',
            )}
          >
            {row.labelVal ?? '—'}
          </div>
          <div className={cn('px-2 py-1 font-medium', !row.match && 'text-destructive')}>
            {row.system}
          </div>
        </div>
      ))}
    </div>
  );
}
