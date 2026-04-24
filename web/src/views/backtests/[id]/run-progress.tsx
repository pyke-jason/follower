import { useState, useEffect } from 'react';
import { InfoChip } from '@/components/info-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBytes, formatCurrency, formatDate, formatDateShort, formatInteger, isoToDateKey } from '@/lib/format';
import type { LiveMetrics } from '@src/backtest/types';
import { Clock, DollarSign, TrendingUp, TrendingDown, Database, Layers, Brain, Pause } from 'lucide-react';

interface RunProgressProps {
  processedMessages: number;
  totalMessages: number;
  llmCost: number;
  liveMetrics: LiveMetrics | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  /** ISO timestamp or YYYY-MM-DD of last processed message */
  lastMessageDate: string | null;
  currentMessageText?: string | null;
  /** ISO or YYYY-MM-DD config start */
  rangeStart: string;
  /** ISO or YYYY-MM-DD config end */
  rangeEnd: string;
}

export function RunProgress({
  processedMessages,
  totalMessages,
  llmCost,
  liveMetrics,
  status,
  startedAt,
  completedAt,
  lastMessageDate,
  currentMessageText,
  rangeStart,
  rangeEnd,
}: RunProgressProps) {
  const isActive = status === 'RUNNING' || status === 'PENDING';
  const isPaused = status === 'PAUSED';
  const isExtracting = isActive && liveMetrics?.phase === 'EXTRACTING';
  const isCompleted = status === 'COMPLETED';

  const startKey = isoToDateKey(rangeStart);
  const endKey = isoToDateKey(rangeEnd);
  const currentKey = lastMessageDate ? isoToDateKey(lastMessageDate) : null;

  // Elapsed timer based on actual run startedAt
  const startMs = startedAt ? new Date(startedAt).getTime() : null;
  const endMs = completedAt ? new Date(completedAt).getTime() : null;

  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (!startMs) return;
    const end = endMs ?? Date.now();
    setElapsed(Math.floor((end - startMs) / 1000));
    if (!isActive) return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startMs) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startMs, endMs, isActive]);

  // During extraction phase, show extraction progress; otherwise show replay progress
  const progressLabel = isExtracting
    ? `Extracting ${formatInteger(liveMetrics.extractedMessages)}/${formatInteger(liveMetrics.totalExtractMessages)}`
    : `${formatInteger(processedMessages)}/${formatInteger(totalMessages)} msgs`;
  const currentDateLabel = lastMessageDate
    ? lastMessageDate.includes('T') ? formatDate(lastMessageDate) : formatDateShort(lastMessageDate)
    : null;
  const currentMessagePreview = currentMessageText ? truncateMessage(currentMessageText) : null;

  // Timeline position: where does currentKey sit between start and end?
  const rangeStartMs = new Date(startKey).getTime();
  const rangeEndMs = new Date(endKey).getTime();
  const rangeSpan = rangeEndMs - rangeStartMs;

  const timelinePct = (() => {
    if (isCompleted) return 100;
    if (!currentKey || rangeSpan <= 0) return 0;
    const currentMs = new Date(currentKey).getTime();
    const raw = ((currentMs - rangeStartMs) / rangeSpan) * 100;
    return Math.max(0, Math.min(100, raw));
  })();

  // Message count pct (used for extraction phase)
  const msgPct = isExtracting
    ? liveMetrics.totalExtractMessages > 0
      ? Math.round((liveMetrics.extractedMessages / liveMetrics.totalExtractMessages) * 100)
      : 0
    : totalMessages > 0
      ? Math.round((processedMessages / totalMessages) * 100)
      : 0;

  // Use timeline pct for replay, msg pct for extraction
  const barPct = isExtracting ? msgPct : timelinePct;

  const elapsedStr = elapsed == null
    ? ''
    : elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
      : `${elapsed}s`;

  // Show current date marker when mid-range during replay
  const showCurrentDate = !isCompleted && !isExtracting && currentKey && timelinePct > 0 && timelinePct < 100;

  // Determine if we have any chip content to show
  const hasChips =
    isExtracting ||
    isPaused ||
    liveMetrics?.unrealizedPnl != null ||
    (liveMetrics != null && liveMetrics.openPositionCount > 0) ||
    llmCost > 0 ||
    (liveMetrics != null && liveMetrics.databentoApiBytesRead > 0) ||
    (startMs != null && elapsed != null && elapsed > 0);

  // Nothing to render when completed with no runtime info
  if (isCompleted && !hasChips) return null;

  return (
    <>
      {/* Chips row: runtime info left, message count right */}
      {(hasChips || !isCompleted) && (
        <div className="flex items-center gap-2 flex-wrap px-4 py-1.5 border-t border-border/50">
          {isExtracting && (
            <InfoChip label="Extracting intents" icon={Brain} />
          )}
          {isPaused && (
            <InfoChip label="Paused" icon={Pause} className="text-warning" />
          )}
          {liveMetrics?.unrealizedPnl != null && (
            <InfoChip
              label={`${formatCurrency(liveMetrics.unrealizedPnl)} unrealized`}
              icon={liveMetrics.unrealizedPnl >= 0 ? TrendingUp : TrendingDown}
              className={liveMetrics.unrealizedPnl >= 0 ? 'text-profit' : 'text-loss'}
            />
          )}
          {liveMetrics != null && liveMetrics.openPositionCount > 0 && (
            <InfoChip label={`${liveMetrics.openPositionCount} open`} icon={Layers} />
          )}
          {llmCost > 0 && (
            <InfoChip
              label={`${formatCurrency(llmCost, 4)} LLM`}
              icon={DollarSign}
            />
          )}
          {liveMetrics != null && liveMetrics.databentoApiBytesRead > 0 && (
            <InfoChip label={`${formatBytes(liveMetrics.databentoApiBytesRead)} data`} icon={Database} />
          )}
          {startMs != null && elapsed != null && elapsed > 0 && (
            <InfoChip label={elapsedStr} icon={Clock} />
          )}

          {/* Message count + current date position — right aligned */}
          <div className="ml-auto flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
            <span>{progressLabel}</span>
            {showCurrentDate && (
              <span className="text-foreground font-medium">{formatDateShort(currentKey)}</span>
            )}
          </div>
        </div>
      )}

      {/* Thin progress bar flush at bottom — only when not completed */}
      {!isCompleted && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="relative h-3 cursor-default"
              aria-label={`${progressLabel}${currentDateLabel ? `, current ${currentDateLabel}` : ''}`}
            >
              <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden bg-primary/10">
                <div
                  className="absolute inset-y-0 left-0 bg-primary transition-all duration-300"
                  style={{ width: `${barPct}%` }}
                />
              </div>
              {showCurrentDate && (
                <div
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 pointer-events-none"
                  style={{ left: `${timelinePct}%` }}
                >
                  <div className="size-2.5 rounded-full bg-primary ring-2 ring-card" />
                </div>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            <div className="space-y-1">
              <div className="font-medium">
                {isExtracting ? 'Extracting intents' : currentDateLabel ?? 'Replay progress'}
              </div>
              <div className="font-mono tabular-nums">{progressLabel}</div>
              {currentMessagePreview && (
                <div className="text-background/80">{currentMessagePreview}</div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

function truncateMessage(message: string): string {
  return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}
