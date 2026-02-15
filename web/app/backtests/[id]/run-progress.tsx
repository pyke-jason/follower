'use client';

import { useState, useEffect } from 'react';
import { Progress } from '@/components/ui/progress';
import { InfoChip } from '../../components/info-chip';
import { formatCurrency } from '@/lib/format';
import { Clock, Cpu, DollarSign, TrendingUp } from 'lucide-react';

interface RunProgressProps {
  runId: string;
  totalMessages?: number;
}

export function RunProgress({ runId, totalMessages }: RunProgressProps) {
  const [progress, setProgress] = useState({
    processed: 0,
    total: totalMessages ?? 0,
    trades: 0,
    agentCalls: 0,
    elapsed: 0,
  });

  useEffect(() => {
    let startTime = Date.now();

    const fetchProgress = async () => {
      try {
        const res = await fetch(`/api/backtests/${runId}/logs?tail=50`);
        if (!res.ok) return;
        const text = await res.text();
        const lines = text.split('\n');

        let processed = progress.processed;
        let total = progress.total;
        let trades = 0;
        let agentCalls = 0;

        for (const line of lines) {
          // Match patterns like [234/1847] or Processing message 234/1847
          const progressMatch = line.match(/\[(\d+)\/(\d+)\]/);
          if (progressMatch) {
            processed = parseInt(progressMatch[1]);
            total = parseInt(progressMatch[2]);
          }
          // Count trade mentions
          const tradeMatch = line.match(/trades?:\s*(\d+)/i);
          if (tradeMatch) trades = parseInt(tradeMatch[1]);
          // Count agent calls
          const agentMatch = line.match(/agent.*calls?:\s*(\d+)/i);
          if (agentMatch) agentCalls = parseInt(agentMatch[1]);
        }

        setProgress({
          processed,
          total: total || totalMessages || 0,
          trades,
          agentCalls,
          elapsed: Math.floor((Date.now() - startTime) / 1000),
        });
      } catch {}
    };

    fetchProgress();
    const interval = setInterval(fetchProgress, 3000);
    const timer = setInterval(() => {
      setProgress((p) => ({ ...p, elapsed: Math.floor((Date.now() - startTime) / 1000) }));
    }, 1000);

    return () => {
      clearInterval(interval);
      clearInterval(timer);
    };
  }, [runId, totalMessages]);

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const estCost = progress.agentCalls * 0.012;
  const elapsedStr = progress.elapsed >= 60
    ? `${Math.floor(progress.elapsed / 60)}m ${progress.elapsed % 60}s`
    : `${progress.elapsed}s`;

  return (
    <div className="rounded-lg border bg-card px-4 py-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">Progress</span>
        <span className="text-muted-foreground tabular-nums">
          {progress.processed.toLocaleString()}/{progress.total.toLocaleString()} messages
        </span>
      </div>
      <Progress value={pct} className="h-2" />
      <div className="flex items-center gap-2 flex-wrap">
        {progress.trades > 0 && (
          <InfoChip label={`${progress.trades} trades`} icon={TrendingUp} />
        )}
        {progress.agentCalls > 0 && (
          <InfoChip label={`${progress.agentCalls} agent calls`} icon={Cpu} />
        )}
        {estCost > 0 && (
          <InfoChip label={`~${formatCurrency(estCost)} est. cost`} icon={DollarSign} />
        )}
        <InfoChip label={elapsedStr} icon={Clock} />
      </div>
    </div>
  );
}
