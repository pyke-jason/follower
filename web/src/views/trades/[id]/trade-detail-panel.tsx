import { useState } from 'react';
import { useTradesStore } from '@/stores/trades-store';
import { SignalDecisionSummary } from './signal-decision-summary';
import { UnifiedTimeline } from './decision-timeline';
import { Badge } from '@/components/badge';
import { Badge as UiBadge } from '@/components/ui/badge';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { X, CircleCheck, XCircle, AlertTriangle } from 'lucide-react';
import type { RunDecision, Trade } from '@src/db/schema';
import type { TradeLabel } from '@src/local-api/http-schemas';
import { formatLegsSummary } from '@src/lib/trade';
import { ExecutionTrace } from './execution-trace';
import { Button } from '@/components/ui/button';
import { NearbyMessages } from '@/views/messages/nearby-messages';

function narrowDecision(d: RunDecision | null) {
  if (!d?.outcome) return null;
  return d;
}

export function TradeDetailPanel({ onClose }: { onClose: () => void }) {
  const trade = useTradesStore((s) => {
    const id = s.selectedTradeId;
    return id ? s.trades.find((t) => t.id === id) ?? null : null;
  });
  const label: TradeLabel | undefined = useTradesStore((s) => {
    const id = s.selectedTradeId;
    return id ? s.labelsByTradeId[id] : undefined;
  });
  const story = useTradesStore((s) => s.story);
  const isLoading = useTradesStore((s) => s.isLoadingStory);
  const channelId = useTradesStore((s) => s.channelId);

  if (!trade) return null;

  // Use OPEN event legs/strategy to show original trade (pre-leg-off)
  const openEvent = story?.events.find(e => e.action === 'OPEN');
  const openLegs = openEvent ? openEvent.legs : trade.legs;
  const openStrategy = openEvent?.strategy ?? trade.strategy;
  const contractSummary = formatLegsSummary(openLegs, openStrategy);

  return (
    <div className="flex flex-col h-full">
      {/* Sticky header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background sticky top-0 z-10">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate">{trade.symbol}</span>
          {contractSummary && <span className="text-xs text-muted-foreground tabular-nums">{contractSummary}</span>}
          <Badge label={trade.status} />
          <Badge label={trade.direction} />
          <Badge label={trade.strategy} />
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="shrink-0 ml-2"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-4 py-4 space-y-5 min-w-0">
        {isLoading ? (
          <p className="text-sm text-muted-foreground text-center py-6">Loading...</p>
        ) : story ? (
          <>
            {/* Signal */}
            <section>
              <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Signal</h4>
              <SignalDecisionSummary
                sourceMessage={story.sourceMessage ? {
                  cleanText: story.sourceMessage.cleanText,
                  author: story.sourceMessage.author,
                  timestamp: formatDate(story.sourceMessage.timestamp),
                } : null}
                decision={narrowDecision(story.decision)}
                taskId={story.task?.id}
              />
            </section>

            {/* Label comparison */}
            <LabelSection label={label} trade={trade} systemDecision={story.decision} />

            {/* Close signal */}
            {story.closeMessage && (
              <section>
                <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Close Signal</h4>
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium">{story.closeMessage.author}</span>
                    <span className="text-[10px] text-muted-foreground/60">{formatDate(story.closeMessage.timestamp)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-3">{story.closeMessage.cleanText}</p>
                </div>
              </section>
            )}

            {/* Execution Trace */}
            {story.decisions.length > 0 && (
              <section>
                <ExecutionTrace decisions={story.decisions} />
              </section>
            )}

            {/* Execution Timeline */}
            {(story.events.length > 0 || story.decisions.length > 0) && (
              <section>
                <UnifiedTimeline />
              </section>
            )}

            {/* Nearby messages */}
            {story.nearbyMessages.length > 0 && (
              <section>
                <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Trader Messages</h4>
                <NearbyMessages
                  messages={story.nearbyMessages}
                  associatedMessageIds={new Set(story.timelineMessages.map(m => m.id))}
                />
              </section>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">Trade data not available</p>
        )}
      </div>
    </div>
  );
}

function LabelSection({ label, trade, systemDecision }: { label: TradeLabel | undefined; trade: Trade; systemDecision: RunDecision | null }) {
  if (!label || label.bucket === 'unlabeled') {
    return (
      <section>
        <div className="flex items-center gap-1.5 mb-2">
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Label</h4>
          <AlertTriangle className="h-3 w-3 text-warning" />
          <span className="text-[10px] text-warning">No label</span>
        </div>
      </section>
    );
  }

  const mismatches = label.match?.mismatches ?? [];
  const isMatch = label.bucket === 'tp' && mismatches.length === 0;
  const isFP = label.bucket === 'fp';

  return (
    <section>
      <div className="flex items-center gap-1.5 mb-2">
        <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Label</h4>
        {isFP ? (
          <>
            <XCircle className="h-3 w-3 text-destructive" />
            <span className="text-[10px] text-destructive font-medium">False positive</span>
          </>
        ) : isMatch ? (
          <>
            <CircleCheck className="h-3 w-3 text-profit" />
            <span className="text-[10px] text-profit">Match</span>
          </>
        ) : (
          <>
            <CircleCheck className="h-3 w-3 text-profit" />
            <span className="text-[10px] text-warning">{mismatches.length} diff{mismatches.length !== 1 ? 's' : ''}</span>
          </>
        )}
        {label.labelConfidence === 'LOW' && (
          <UiBadge variant="outline" className="text-[9px] px-1 py-0 h-3.5">LOW</UiBadge>
        )}
      </div>

      {/* Side-by-side reasoning */}
      {(label.labelReasoning || systemDecision?.reasoning) && (
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground block mb-0.5">Label reasoning</span>
            <p className="text-xs text-muted-foreground leading-relaxed">{label.labelReasoning ?? '—'}</p>
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground block mb-0.5">System reasoning</span>
            <p className="text-xs text-muted-foreground leading-relaxed">{systemDecision?.reasoning ?? '—'}</p>
          </div>
        </div>
      )}

      {/* Side-by-side field comparison */}
      <LabelDiffTable label={label} trade={trade} mismatches={mismatches} />

      {/* Verdict */}
      {label.labelId && (
        <LabelVerdict labelId={label.labelId} humanVerified={label.humanVerified} rejectionReason={label.rejectionReason} />
      )}
    </section>
  );
}

function LabelVerdict({ labelId, humanVerified, rejectionReason }: { labelId: string; humanVerified: boolean; rejectionReason: string | null }) {
  const [loading, setLoading] = useState(false);
  const tradeId = useTradesStore((s) => s.selectedTradeId);
  const updateLabel = useTradesStore((s) => s.updateLabel);

  const currentVerdict = humanVerified ? (rejectionReason ?? 'LABEL_CORRECT') : null;

  const submit = async (action: 'approve' | 'reject', reason?: string) => {
    setLoading(true);
    try {
      const url = `/api/eval/labels/${labelId}/${action}`;
      const body = action === 'reject' ? JSON.stringify({ reason }) : undefined;
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
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
      await fetch(`/api/eval/labels/${labelId}/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
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
      <div className="flex items-center gap-2 mt-3 pt-2 border-t">
        <UiBadge variant="secondary" className="text-[10px]">
          {verdictLabels[currentVerdict] ?? currentVerdict}
        </UiBadge>
        <Button variant="ghost" size="xs" className="text-[10px] h-5 text-muted-foreground" disabled={loading} onClick={undo}>
          Undo
        </Button>
      </div>
    );
  }

  return (
    <div className="flex gap-1.5 mt-3 pt-2 border-t">
      <Button variant="outline" size="xs" className="text-[10px] h-6" disabled={loading} onClick={() => submit('approve')}>
        Label correct
      </Button>
      <Button variant="outline" size="xs" className="text-[10px] h-6" disabled={loading} onClick={() => submit('reject', 'SYSTEM_CORRECT')}>
        System correct
      </Button>
      <Button variant="outline" size="xs" className="text-[10px] h-6" disabled={loading} onClick={() => submit('reject', 'BOTH_WRONG')}>
        Both wrong
      </Button>
    </div>
  );
}

type DiffRow = { field: string; label: string; system: string; match: boolean };

function LabelDiffTable({ label, trade, mismatches }: { label: TradeLabel; trade: Trade; mismatches: { path: string; expected: string; got: string }[] }) {
  const mismatchMap = new Map(mismatches.map(m => [m.path, m]));
  const sig = label.labelSignals?.[0] ?? null;

  // Always show full trade details on the system side
  const legsSummary = formatLegsSummary(trade.legs, trade.strategy);
  const tradeFields: { field: string; system: string; labelVal: string | null; match: boolean }[] = [
    {
      field: 'isTrade',
      system: 'true',
      labelVal: label.labelIsTrade != null ? String(label.labelIsTrade) : null,
      match: label.labelIsTrade === true,
    },
    {
      field: 'action',
      system: sig ? (mismatchMap.get('action')?.got ?? String(sig.action ?? '—')) : (trade.status === 'CANCELLED' ? 'CANCELLED' : 'OPEN'),
      labelVal: sig ? String(sig.action ?? '—') : null,
      match: !mismatchMap.has('action'),
    },
    { field: 'symbol', system: trade.symbol, labelVal: sig ? String(sig.symbol ?? '—') : null, match: !mismatchMap.has('symbol') },
    { field: 'direction', system: trade.direction, labelVal: sig ? String(sig.direction ?? 'null') : null, match: !mismatchMap.has('direction') },
    { field: 'strategy', system: trade.strategy, labelVal: sig ? String(sig.strategy ?? 'null') : null, match: !mismatchMap.has('strategy') },
  ];

  // Always show strikes/expiry/price from the trade — these matter for judging correctness
  if (legsSummary) tradeFields.push({ field: 'strikes', system: legsSummary, labelVal: sig?.strikes ? JSON.stringify(sig.strikes) : null, match: true });

  // Extract expiry from legs if available
  const tradeExpiry = trade.legs?.find((l: { expiry?: string }) => l.expiry)?.expiry;
  if (tradeExpiry || sig?.expiry) {
    tradeFields.push({ field: 'expiry', system: tradeExpiry ?? '—', labelVal: sig?.expiry ? String(sig.expiry) : null, match: true });
  }

  if (trade.entryPrice || (sig && sig.statedPrice != null)) {
    tradeFields.push({ field: 'price', system: trade.entryPrice ?? '—', labelVal: sig && sig.statedPrice != null ? String(sig.statedPrice) : null, match: true });
  }

  if (trade.quantity || (sig && sig.quantity != null)) {
    tradeFields.push({ field: 'quantity', system: String(trade.quantity ?? '—'), labelVal: sig && sig.quantity != null ? String(sig.quantity) : null, match: true });
  }

  return (
    <div className="text-xs border rounded-md overflow-hidden">
      <div className="grid grid-cols-[72px_1fr_1fr] bg-muted/50 border-b">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Field</div>
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Label</div>
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">System</div>
      </div>
      {tradeFields.map((r) => (
        <div key={r.field} className={cn(
          'grid grid-cols-[72px_1fr_1fr] border-b last:border-b-0',
          !r.match && 'bg-destructive/5',
        )}>
          <div className="px-2 py-1 font-mono text-muted-foreground">{r.field}</div>
          <div className={cn('px-2 py-1', r.labelVal == null ? 'text-muted-foreground/40' : 'font-medium')}>
            {r.labelVal ?? '—'}
          </div>
          <div className={cn('px-2 py-1 font-medium', !r.match && 'text-destructive')}>
            {r.system}
          </div>
        </div>
      ))}
    </div>
  );
}
