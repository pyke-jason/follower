'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '../components/badge';
import { Sparkline } from '../components/sparkline';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate } from '@/lib/format';
import Link from 'next/link';
import { Star, GitCompareArrows } from 'lucide-react';
import type { BacktestRunConfig, BacktestRunSummary } from '../../../src/db/schema';
import { pctDisplay } from '../../../src/lib/numbers';
import { togglePin } from './actions';

function formatDuration(ms: number | null): string {
  if (ms == null) return '--';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

type Run = {
  id: string;
  status: string;
  config: unknown;
  summary: unknown;
  equityCurve: unknown;
  durationMs: number | null;
  createdAt: string | null;
  pinned: boolean | null;
  experimentTag: string | null;
  name: string | null;
};

export function BacktestList({
  runs,
  experimentTags,
}: {
  runs: Run[];
  experimentTags: string[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const filteredRuns = tagFilter
    ? runs.filter((r) => r.experimentTag === tagFilter)
    : runs;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 3) next.add(id);
      return next;
    });
  }

  function handleCompare() {
    const ids = Array.from(selected).join(',');
    router.push(`/backtests/compare?ids=${ids}`);
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        {experimentTags.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Tag:</span>
            <Button
              variant={tagFilter === null ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setTagFilter(null)}
            >
              All
            </Button>
            {experimentTags.map((tag) => (
              <Button
                key={tag}
                variant={tagFilter === tag ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setTagFilter(tag)}
              >
                {tag}
              </Button>
            ))}
          </div>
        )}
        <div className="flex-1" />
        {selected.size >= 2 && (
          <Button size="sm" onClick={handleCompare} className="gap-1.5">
            <GitCompareArrows className="h-3.5 w-3.5" />
            Compare ({selected.size})
          </Button>
        )}
      </div>

      <Card className="py-0 gap-0 overflow-hidden animate-in-up">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead className="w-8"></TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Traders</TableHead>
                <TableHead>Date Range</TableHead>
                <TableHead className="text-right">Trades</TableHead>
                <TableHead className="text-right">Win Rate</TableHead>
                <TableHead className="text-right">P&L</TableHead>
                <TableHead className="w-[72px]">Curve</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRuns.map((run) => {
                const config = run.config as BacktestRunConfig;
                const summary = run.summary as BacktestRunSummary | null;
                const equityCurve = run.equityCurve as { date: string; pnl: number; cumPnl: number }[] | null;
                const sparkData = equityCurve?.map((e) => e.cumPnl) ?? [];
                const startDate = config.startDate.split('T')[0];
                const endDate = config.endDate.split('T')[0];
                const pnlColor = summary && summary.totalPnl > 0
                  ? 'text-emerald-400'
                  : summary && summary.totalPnl < 0
                    ? 'text-red-400'
                    : '';
                const isSelected = selected.has(run.id);

                return (
                  <TableRow key={run.id} className={`hover:bg-accent/40 transition-colors ${isSelected ? 'bg-accent/20' : ''}`}>
                    <TableCell className="pr-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(run.id)}
                        className="h-3.5 w-3.5 rounded border-border accent-primary"
                        disabled={!isSelected && selected.size >= 3}
                      />
                    </TableCell>
                    <TableCell className="px-0">
                      <form action={togglePin}>
                        <input type="hidden" name="runId" value={run.id} />
                        <button type="submit" className="p-0.5 hover:text-amber-400 transition-colors">
                          <Star className={`h-3.5 w-3.5 ${run.pinned ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'}`} />
                        </button>
                      </form>
                    </TableCell>
                    <TableCell>
                      <Link href={`/backtests/${run.id}`} className="inline-block">
                        <Badge label={run.status} />
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/backtests/${run.id}`} className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40">
                        {run.name ?? config.traders.join(', ')}
                      </Link>
                      {run.experimentTag && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground bg-muted/40 px-1 py-0.5 rounded border border-border/30 border-dashed">
                          {run.experimentTag}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs tabular-nums">
                      {startDate} &ndash; {endDate}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{summary?.totalTrades ?? '--'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {summary ? pctDisplay(summary.winRate) : '--'}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${pnlColor}`}>
                      {summary ? formatCurrency(summary.totalPnl) : '--'}
                    </TableCell>
                    <TableCell>
                      {sparkData.length > 1 && (
                        <Sparkline data={sparkData} width={60} height={24} />
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs tabular-nums">
                      {formatDuration(run.durationMs)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(run.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {filteredRuns.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No backtest runs{tagFilter ? ` with tag "${tagFilter}"` : ' yet'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
