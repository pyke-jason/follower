'use client';

import { useState, useEffect } from 'react';
import { Progress } from '@/components/ui/progress';
import { InfoChip } from '../../components/info-chip';
import { formatCurrency } from '@/lib/format';
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
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
}: RunProgressProps) {
  const isActive = status === 'RUNNING' || status === 'PENDING';
  const isExtracting = isActive && liveMetrics?.phase === 'EXTRACTING';

  // Elapsed timer based on actual run startedAt
  const startMs = startedAt ? new Date(startedAt).getTime() : null;
  const endMs = completedAt ? new Date(completedAt).getTime() : null;

  const [elapsed, setElapsed] = useState(() => {
    if (!startMs) return 0;
    const end = endMs ?? Date.now();
    return Math.floor((end - startMs) / 1000);
  });

  useEffect(() => {
    if (!isActive || !startMs) return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startMs) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startMs, isActive]);

  // During extraction phase, show extraction progress; otherwise show replay progress
  const progressLabel = isExtracting
    ? `Extracting intents... ${liveMetrics.extractedMessages.toLocaleString()}/${liveMetrics.totalExtractMessages.toLocaleString()}`
    : `${processedMessages.toLocaleString()}/${totalMessages.toLocaleString()} messages`;

  const pct = isExtracting
    ? liveMetrics.totalExtractMessages > 0
      ? Math.round((liveMetrics.extractedMessages / liveMetrics.totalExtractMessages) * 100)
      : 0
    : totalMessages > 0
      ? Math.round((processedMessages / totalMessages) * 100)
      : 0;

  const llmCost = estimateLlmCost(agentModel, {
    inputTokens: llmTokens.input,
    outputTokens: llmTokens.output,
  });

  const elapsedStr = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  return (
    <div className="rounded-lg border bg-card px-4 py-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">Progress</span>
        <span className="text-muted-foreground tabular-nums">
          {progressLabel}
        </span>
      </div>
      <Progress value={pct} className="h-2" />
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
        {startMs != null && elapsed > 0 && (
          <span suppressHydrationWarning>
            <InfoChip label={elapsedStr} icon={Clock} />
          </span>
        )}
      </div>
    </div>
  );
}
