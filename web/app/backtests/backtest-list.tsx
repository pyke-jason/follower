'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '../components/badge';
import { Sparkline } from '../components/sparkline';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate, isoToDateKey } from '@/lib/format';
import Link from 'next/link';
import { Star, GitCompareArrows, Trash2 } from 'lucide-react';
import { getConfig, getSummary, getEquityCurve } from '../../../src/db/accessors';
import { pctDisplay, PROFIT_FACTOR_INF } from '../../../src/lib/numbers';
import { togglePin, bulkDeleteBacktestRuns } from './actions';

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
  const [deleting, startDelete] = useTransition();

  const filteredRuns = tagFilter
    ? runs.filter((r) => r.experimentTag === tagFilter)
    : runs;

  const allFilteredIds = filteredRuns.map((r) => r.id);
  const allSelected = filteredRuns.length > 0 && allFilteredIds.every((id) => selected.has(id));
  const someSelected = allFilteredIds.some((id) => selected.has(id));

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of allFilteredIds) next.delete(id);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of allFilteredIds) next.add(id);
        return next;
      });
    }
  }

  function handleCompare() {
    const ids = Array.from(selected).slice(0, 3).join(',');
    router.push(`/backtests/compare?ids=${ids}`);
  }

  function handleBulkDelete() {
    const count = selected.size;
    if (!confirm(`Delete ${count} backtest run${count === 1 ? '' : 's'}? This cannot be undone.`)) return;
    const ids = Array.from(selected);
    startDelete(async () => {
      await bulkDeleteBacktestRuns(ids);
      setSelected(new Set());
    });
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
        {selected.size > 0 && (
          <Button
            size="sm"
            variant="destructive"
            onClick={handleBulkDelete}
            disabled={deleting}
            className="gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete ({selected.size})
          </Button>
        )}
        {selected.size >= 2 && selected.size <= 3 && (
          <Button size="sm" variant="outline" onClick={handleCompare} className="gap-1.5">
            <GitCompareArrows className="h-3.5 w-3.5" />
            Compare ({selected.size})
          </Button>
        )}
        <Button size="sm" asChild>
          <Link href="/backtests/new">New Backtest</Link>
        </Button>
      </div>

      <Card className="py-0 gap-0 overflow-hidden animate-in-up">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    onChange={toggleSelectAll}
                    className="h-3.5 w-3.5 rounded border-border accent-primary"
                  />
                </TableHead>
                <TableHead className="w-8"></TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Traders</TableHead>
                <TableHead>Date Range</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Trades</TableHead>
                <TableHead className="text-right">Win Rate</TableHead>
                <TableHead className="text-right">P&L</TableHead>
                <TableHead className="text-right">PF</TableHead>
                <TableHead className="text-right">Max DD</TableHead>
                <TableHead className="w-[72px]">Curve</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRuns.map((run) => {
                const config = getConfig(run);
                const summary = getSummary(run);
                const equityCurve = getEquityCurve(run);
                const sparkData = equityCurve?.map((e) => e.cumPnl) ?? [];
                const startDate = isoToDateKey(config.startDate);
                const endDate = isoToDateKey(config.endDate);
                const displayPnl = summary
                  ? ((summary.totalCommissions ?? 0) > 0 ? (summary.netPnl ?? summary.totalPnl) : summary.totalPnl)
                  : 0;
                const pnlColor = summary && displayPnl > 0
                  ? 'text-profit'
                  : summary && displayPnl < 0
                    ? 'text-loss'
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
                      />
                    </TableCell>
                    <TableCell className="px-0">
                      <form action={togglePin}>
                        <input type="hidden" name="runId" value={run.id} />
                        <button type="submit" className="p-0.5 hover:text-warning transition-colors">
                          <Star className={`h-3.5 w-3.5 ${run.pinned ? 'fill-warning text-warning' : 'text-muted-foreground/40'}`} />
                        </button>
                      </form>
                    </TableCell>
                    <TableCell>
                      <Link href={`/backtests/${run.id}`} className="inline-block">
                        <Badge label={run.status} />
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-[180px]">
                      <Link href={`/backtests/${run.id}`} className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40 truncate block" title={run.name ?? config.traders.join(', ')}>
                        {run.name ?? config.traders.join(', ')}
                      </Link>
                      {run.experimentTag && (
                        <span className="text-[10px] text-muted-foreground bg-muted/40 px-1 py-0.5 rounded border border-border/30 border-dashed">
                          {run.experimentTag}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs tabular-nums">
                      {startDate} &ndash; {endDate}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs truncate max-w-[120px]" title={config.agentModel ?? 'default'}>
                      {(config.agentModel ?? 'default').replace(/^(claude-|grok-)/, '').replace(/-202\d+$/, '')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{summary?.totalTrades ?? '--'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {summary ? pctDisplay(summary.winRate) : '--'}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${pnlColor}`}>
                      {summary ? formatCurrency(displayPnl) : '--'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {summary ? (summary.profitFactor >= PROFIT_FACTOR_INF ? '99.99' : summary.profitFactor.toFixed(2)) : '--'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {summary ? formatCurrency(summary.maxDrawdown) : '--'}
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
