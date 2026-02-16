'use client';

import Link from 'next/link';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { RunScopeSelector } from './run-scope-selector';
import { SignalSheet } from './signal-sheet';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { useRunScope } from './run-scope-provider';

export function TopBar() {
  const { runId, runBrief: brief, status, selectRun } = useRunScope();

  const pnl = status?.todayPnl ?? 0;
  const pnlSign = pnl >= 0 ? '+' : '';
  const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-red-400' : 'text-muted-foreground';
  const PnlIcon = pnl >= 0 ? TrendingUp : TrendingDown;

  const showLiveAlert = !runId && (status?.tradingBlocked || (status?.unresolvedAlertCount ?? 0) > 0);

  const formatDateRange = (start: string, end: string) => {
    const fmt = (d: string) => {
      const date = new Date(d + 'T00:00:00');
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    return `${fmt(start)}\u2013${fmt(end)}`;
  };

  const fmtCurrency = (v: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(v);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 !h-4" />

        {/* Live alert indicator */}
        {showLiveAlert && (
          <span className="relative flex h-2.5 w-2.5 mr-1">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
        )}

        {/* Persistent status metrics */}
        {status && (
          <div className="flex items-center gap-4 animate-in-right">
            {/* P&L */}
            <div className="flex items-center gap-1.5">
              <PnlIcon className={`h-3.5 w-3.5 ${pnlColor}`} />
              <span className={`text-sm font-semibold tabular-nums ${pnlColor}`}>
                {pnlSign}
                {fmtCurrency(pnl)}
              </span>
            </div>

            {/* Open positions */}
            {status.openTrades > 0 && (
              <>
                <Separator orientation="vertical" className="!h-3.5" />
                <span className="text-xs text-muted-foreground tabular-nums">
                  {status.openTrades} open
                </span>
              </>
            )}

            {/* Pending tasks */}
            {status.pendingTasks > 0 && (
              <>
                <Separator orientation="vertical" className="!h-3.5" />
                <span className="text-xs text-amber-400/80 tabular-nums">
                  {status.pendingTasks} pending
                </span>
              </>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Signal sheet trigger + Run scope */}
        <div className="flex items-center gap-1.5">
          <SignalSheet />
          <RunScopeSelector />
        </div>
      </header>

      {/* Backtest context bar */}
      {runId && brief && (
        <div className="flex h-8 shrink-0 items-center gap-3 border-b border-blue-500/20 bg-blue-950/40 px-4 text-xs">
          <Link
            href={`/backtests/${brief.id}`}
            className="text-blue-400 hover:text-blue-300 whitespace-nowrap"
          >
            &larr; Back to Run Details
          </Link>

          <span className="text-muted-foreground">&middot;</span>
          <span className="text-muted-foreground whitespace-nowrap">
            {formatDateRange(brief.startDate, brief.endDate)}
          </span>

          <span className="text-muted-foreground">&middot;</span>
          <span className="text-muted-foreground whitespace-nowrap">
            {brief.agentModel}
          </span>

          <span className="text-muted-foreground">&middot;</span>
          <span
            className={`font-semibold tabular-nums whitespace-nowrap ${
              brief.totalPnl > 0
                ? 'text-emerald-400'
                : brief.totalPnl < 0
                  ? 'text-red-400'
                  : 'text-muted-foreground'
            }`}
          >
            {brief.totalPnl >= 0 ? '+' : ''}
            {fmtCurrency(brief.totalPnl)} P&L
          </span>

          <span className="text-muted-foreground">&middot;</span>
          <span className="text-muted-foreground tabular-nums whitespace-nowrap">
            {Math.round(brief.winRate)}% WR
          </span>

          <span className="text-muted-foreground">&middot;</span>
          <span className="text-muted-foreground tabular-nums whitespace-nowrap">
            {brief.totalTrades} trades
          </span>

          <div className="flex-1" />

          <button
            onClick={() => selectRun(null)}
            className="text-muted-foreground hover:text-foreground whitespace-nowrap"
          >
            &times; Exit Scope
          </button>
        </div>
      )}
    </>
  );
}
