'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/format';
import { DecisionScatter } from './decision-scatter';
import { safeParseFloat } from '../../../../src/lib/numbers';

type Decision = {
  id: string;
  path: string;
  decision: string;
  reasoning: string | null;
  pnl: string | null;
  durationMs: number | null;
  createdAt: string | null;
};

type Message = {
  cleanText: string;
  author: string;
  timestamp: string;
};

type DecisionRow = {
  decision: Decision;
  message: Message;
  trade: { id: string; symbol: string; taskId: string | null; pnl: string | null } | null;
};

type SortKey = 'pnl' | 'date' | 'decision';
type FilterKey = 'all' | 'EXECUTE' | 'SKIP';

export function AgentDecisions({ rows, backtestRunId }: { rows: DecisionRow[]; backtestRunId: string }) {
  const [sortBy, setSortBy] = useState<SortKey>('date');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const executedCount = rows.filter((r) => r.decision.decision === 'EXECUTE').length;
  const skippedCount = rows.filter((r) => r.decision.decision === 'SKIP').length;

  const filtered = useMemo(() => {
    let result = [...rows];
    if (filter !== 'all') {
      result = result.filter((r) => r.decision.decision === filter);
    }
    result.sort((a, b) => {
      if (sortBy === 'pnl') {
        const aPnl = safeParseFloat(a.decision.pnl);
        const bPnl = safeParseFloat(b.decision.pnl);
        return bPnl - aPnl;
      }
      if (sortBy === 'decision') {
        return a.decision.decision.localeCompare(b.decision.decision);
      }
      // date desc
      return (b.decision.createdAt ?? '').localeCompare(a.decision.createdAt ?? '');
    });
    return result;
  }, [rows, sortBy, filter]);

  const scatterData = rows
    .filter((r) => r.decision.pnl != null)
    .map((r) => ({
      date: r.message.timestamp.split('T')[0],
      pnl: safeParseFloat(r.decision.pnl),
      decision: r.decision.decision,
      message: r.message.cleanText.slice(0, 60),
    }));

  // Aggregate skip reasons from reasoning strings
  const skipReasonCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (r.decision.decision !== 'SKIP' || !r.decision.reasoning) continue;
      const reason = r.decision.reasoning;
      let category = reason;
      if (reason.startsWith('risk blocked:') || reason.includes('notional exposure')) category = 'risk blocked';
      else if (reason.startsWith('Execution error:') || reason.includes('No Databento data') || reason.includes('No price seeded')) category = 'no market data';
      else if (reason.includes('no open position')) category = 'no open position';
      else if (reason.includes('sizing returned 0')) category = 'sizing returned 0';
      else if (reason.includes('limit order not filled')) category = 'limit not filled';
      else if (reason.includes('Low confidence') || reason.includes('agent disabled')) category = 'low confidence';
      else if (reason.includes('Agent budget')) category = 'agent budget';
      else if (reason.includes('no price') || reason.includes('no symbol') || reason.includes('no detected strategy')) category = 'missing data';
      else if (reason.includes('Agent error')) category = 'agent error';
      else if (reason.includes('Agent decided to skip')) category = 'agent skip';
      else if (reason.includes('paper trade')) category = 'paper trade';
      else if (reason.includes('no badges')) category = 'no badges';
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4 text-sm">
        <span className="text-emerald-400 font-medium">{executedCount} executed</span>
        <span className="text-muted-foreground">|</span>
        <span className="text-zinc-400 font-medium">{skippedCount} skipped</span>
        <span className="text-muted-foreground">|</span>
        <span className="text-muted-foreground">{rows.length} total decisions</span>
      </div>

      {/* Skip reason breakdown */}
      {skipReasonCounts.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">Skip reasons:</span>
          {skipReasonCounts.map(([reason, count]) => (
            <Badge key={reason} variant="outline" className="text-xs font-normal text-zinc-400 border-zinc-700">
              {reason} ({count})
            </Badge>
          ))}
        </div>
      )}

      {/* Scatter chart */}
      {scatterData.length > 0 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Decision Outcomes</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            <DecisionScatter data={scatterData} />
          </CardContent>
        </Card>
      )}

      {/* Controls */}
      <div className="flex gap-2 flex-wrap items-center">
        <span className="text-xs text-muted-foreground mr-1">Sort:</span>
        {(['date', 'pnl', 'decision'] as SortKey[]).map((s) => (
          <Button
            key={s}
            variant={sortBy === s ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setSortBy(s)}
            className="text-xs h-7"
          >
            {s === 'pnl' ? 'P&L' : s === 'date' ? 'Date' : 'Decision'}
          </Button>
        ))}
        <span className="text-muted-foreground">|</span>
        <span className="text-xs text-muted-foreground mr-1">Filter:</span>
        {(['all', 'EXECUTE', 'SKIP'] as FilterKey[]).map((f) => (
          <Button
            key={f}
            variant={filter === f ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFilter(f)}
            className="text-xs h-7"
          >
            {f === 'all' ? 'All' : f === 'EXECUTE' ? 'Executed' : 'Skipped'}
          </Button>
        ))}
      </div>

      {/* Decision list */}
      <div className="space-y-1">
        {filtered.map((row) => {
          const pnl = row.decision.pnl != null ? safeParseFloat(row.decision.pnl) : null;
          const isExpanded = expandedId === row.decision.id;
          const hasTradeLink = row.decision.decision === 'EXECUTE' && row.trade?.id;

          const content = (
            <div
              key={row.decision.id}
              className="border border-border rounded-md px-3 py-2 hover:bg-muted/30 transition-colors cursor-pointer"
              onClick={() => setExpandedId(isExpanded ? null : row.decision.id)}
            >
              <div className="flex items-center gap-3 text-sm">
                <Badge className={
                  row.decision.decision === 'EXECUTE'
                    ? 'bg-emerald-900/50 text-emerald-300'
                    : 'bg-zinc-800 text-zinc-400'
                }>
                  {row.decision.decision}
                </Badge>
                <span className="text-xs text-muted-foreground shrink-0">
                  {row.decision.path}
                </span>
                <span className="text-foreground truncate flex-1 text-xs">
                  {row.message.cleanText.slice(0, 80)}
                </span>
                {pnl !== null && (
                  <span className={`tabular-nums font-medium shrink-0 ${pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-red-400' : 'text-foreground'}`}>
                    {formatCurrency(pnl)}
                  </span>
                )}
                {row.decision.durationMs != null && (
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                    {row.decision.durationMs < 1000
                      ? `${row.decision.durationMs}ms`
                      : `${(row.decision.durationMs / 1000).toFixed(1)}s`}
                  </span>
                )}
                {hasTradeLink && (
                  <Link
                    href={`/trades/${row.trade!.id}?run=${backtestRunId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>
              {isExpanded && row.decision.reasoning && (
                <div className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap border-t border-border pt-2">
                  {row.decision.reasoning}
                </div>
              )}
            </div>
          );

          return <div key={row.decision.id}>{content}</div>;
        })}
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-6">
          No decisions match the current filter.
        </p>
      )}
    </div>
  );
}
