import { useQuery } from '@tanstack/react-query';
import { NearbyMessages } from '@/views/messages/nearby-messages';
import { EmptyState } from '@/components/empty-state';
import { computeDiffSummary, DiffSummaryBadge } from './diff-cell';
import { VerdictPanel } from './verdict-panel';
import { api } from '@/lib/api';
import type { Message } from '@src/db/schema';
import type { Signal } from '@src/agent/schemas';
import type { ClassifyDecisionRow, ClassifyLabelRow } from '@src/local-api/http-schemas';
import { Badge } from '@/components/badge';
import { formatDate } from '@/lib/format';
import { getClassifierSignalsFromSnapshot } from '@/lib/snapshot-accessors';

export function ContextPanel({
  row,
  label,
  runId,
  onClose,
}: {
  row: ClassifyDecisionRow | null;
  label: ClassifyLabelRow | undefined;
  runId: string;
  onClose: () => void;
}) {
  if (!row) {
    return <EmptyState title="Select a message" hint="Click a row to see chat context and the label/classifier diff" />;
  }

  return <ContextPanelContent row={row} label={label} runId={runId} onClose={onClose} />;
}

function ContextPanelContent({
  row,
  label,
  runId,
  onClose: _onClose,
}: {
  row: ClassifyDecisionRow;
  label: ClassifyLabelRow | undefined;
  runId: string;
  onClose: () => void;
}) {
  const author = row.message.author;
  const timestamp = row.message.timestamp;
  const messageId = row.decision.messageId ?? null;

  const query = useQuery({
    queryKey: ['message-context', author, timestamp],
    queryFn: () =>
      api<Message[]>(
        `/messages/nearby?author=${encodeURIComponent(author)}&timestamp=${encodeURIComponent(timestamp)}&window=360`,
      ),
    enabled: !!author && !!timestamp,
  });

  const activeLabel = label ? (label.humanLabel ?? label.label) : null;
  const labelSignal = activeLabel?.trades?.[0]?.[0] ?? null;
  const classifierSignals = getClassifierSignalsFromSnapshot(row.decision.snapshot);
  const classifierSignal = classifierSignals[0] ?? null;
  const diffSummary = computeDiffSummary(labelSignal, classifierSignal);

  return (
    <div>
      <div className="border-b p-3 space-y-1">
        <div className="text-xs text-muted-foreground space-x-2">
          <span className="font-medium text-foreground">{author}</span>
          <span>{formatDate(timestamp)}</span>
          {row.decision.outcome && <Badge label={row.decision.outcome} />}
          <DiffSummaryBadge
            summary={diffSummary}
            labelIsTrade={activeLabel?.isTrade ?? null}
            classifierIsTrade={classifierSignals.length > 0}
          />
        </div>
        <div className="text-sm break-words">{row.message.cleanText ?? ''}</div>
        {row.decision.reasoning && (
          <div className="text-xs italic text-muted-foreground break-words">
            {row.decision.reasoning}
          </div>
        )}
      </div>

      <div className="border-b p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Label vs Classifier</div>
        <VerdictPanel label={label} classifierSignals={classifierSignals} runId={runId} />
      </div>

      <div className="p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Trader Messages</div>
        {query.isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
        {query.isError && <div className="text-xs text-loss">Failed to load context.</div>}
        {query.data && (
          <NearbyMessages
            messages={query.data}
            associatedMessageIds={new Set(messageId ? [messageId] : [])}
          />
        )}
      </div>
    </div>
  );
}

type EvalLabelLite = { isTrade?: boolean; trades?: Signal[][] };
export function getLabelSignals(label: ClassifyLabelRow | undefined): { isTrade: boolean | null; trade: Signal[] | null } {
  if (!label) return { isTrade: null, trade: null };
  const active = (label.humanLabel ?? label.label) as EvalLabelLite | null;
  if (!active) return { isTrade: null, trade: null };
  const isTrade = !!active.isTrade;
  const trade = active.trades?.[0] ?? null;
  return { isTrade, trade };
}
