'use client';

import { useState, useEffect } from 'react';
import { InfoChip } from '../../components/info-chip';
import { formatBytes, formatCurrency, formatDateShort, isoToDateKey } from '@/lib/format';
import { estimateLlmCost } from '../../../../src/lib/llm-cost';
import type { LiveMetrics } from '../../../../src/backtest/types';
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
    ? `Extracting intents... ${liveMetrics.extractedMessages.toLocaleString()}/${liveMetrics.totalExtractMessages.toLocaleString()}`
    : `${processedMessages.toLocaleString()}/${totalMessages.toLocaleString()} messages`;

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

  // Show the current date marker when not completed and we have a mid-range date
  const showMarker = !isCompleted && !isExtracting && currentKey && timelinePct > 0 && timelinePct < 100;

  return (
    <div className="rounded-lg border bg-card px-4 py-3 space-y-2">
      {/* Header: label left, message count right */}
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">Progress</span>
        <span className="text-muted-foreground tabular-nums">
          {progressLabel}
        </span>
      </div>

      {/* Timeline bar with date labels */}
      <div className="space-y-1">
        <div className="relative">
          {/* Bar track */}
          <div className="h-2 w-full rounded-full bg-primary/20 overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${barPct}%` }}
            />
          </div>
          {/* Current-date marker */}
          {showMarker && (
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 pointer-events-none"
              style={{ left: `${timelinePct}%` }}
            >
              <div className="size-3 rounded-full bg-primary ring-2 ring-card" />
            </div>
          )}
        </div>
        {/* Date labels under the bar */}
        <div className="relative flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>{formatDateShort(startKey)}</span>
          {showMarker && currentKey && (
            <span
              className="absolute text-foreground font-medium"
              style={{ left: `${timelinePct}%`, transform: 'translateX(-50%)' }}
            >
              {formatDateShort(currentKey)}
            </span>
          )}
          <span>{formatDateShort(endKey)}</span>
        </div>
      </div>

      {/* Info chips */}
      <div className="flex items-center gap-2 flex-wrap">
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
      </div>
    </div>
  );
}
