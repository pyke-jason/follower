'use client';

import { useState, useEffect } from 'react';
import { InfoChip } from '../../components/info-chip';
import { formatBytes, formatCurrency, formatDateShort, isoToDateKey } from '@/lib/format';
import { estimateLlmCost } from '@src/lib/llm-cost';
import type { LiveMetrics } from '@src/backtest/types';
import { Clock, DollarSign, TrendingUp, TrendingDown, Database, Layers, Brain } from 'lucide-react';

interface RunProgressProps {
  processedMessages: number;
  totalMessages: number;
  agentModel: string;
  llmTokens: { input: number; output: number };
  liveMetrics: LiveMetrics | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  /** ISO timestamp or YYYY-MM-DD of last processed message */
  lastMessageDate: string | null;
  /** ISO or YYYY-MM-DD config start */
  rangeStart: string;
  /** ISO or YYYY-MM-DD config end */
  rangeEnd: string;
}

export function RunProgress({
  processedMessages,
  totalMessages,
  agentModel,
  llmTokens,
  liveMetrics,
  status,
  startedAt,
  completedAt,
  lastMessageDate,
  rangeStart,
  rangeEnd,
}: RunProgressProps) {
  const isActive = status === 'RUNNING' || status === 'PENDING';
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
    ? `Extracting ${liveMetrics.extractedMessages.toLocaleString()}/${liveMetrics.totalExtractMessages.toLocaleString()}`
    : `${processedMessages.toLocaleString()}/${totalMessages.toLocaleString()} msgs`;

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

  const llmCost = estimateLlmCost(agentModel, {
    inputTokens: llmTokens.input,
    outputTokens: llmTokens.output,
  });

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
            <InfoChip label={`~${formatCurrency(llmCost)} LLM`} icon={DollarSign} />
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
        <div className="relative h-1.5 bg-primary/10">
          <div
            className="absolute inset-y-0 left-0 bg-primary transition-all duration-300"
            style={{ width: `${barPct}%` }}
          />
          {showCurrentDate && (
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 pointer-events-none"
              style={{ left: `${timelinePct}%` }}
            >
              <div className="size-2.5 rounded-full bg-primary ring-2 ring-card" />
            </div>
          )}
        </div>
      )}
    </>
  );
}
