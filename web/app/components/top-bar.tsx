import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { ChannelScopeSelector } from './channel-scope-selector';
import { SignalSheet } from './signal-sheet';
import { ThemeToggle } from './theme-toggle';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { useChannelStore } from '@/stores/channel-store';

export function TopBar() {
  const status = useChannelStore((s) => s.status);
  const statusError = useChannelStore((s) => s.statusError);

  const pnl = status?.todayPnl ?? 0;
  const pnlSign = pnl >= 0 ? '+' : '';
  const pnlColor = pnl > 0 ? 'text-profit' : pnl < 0 ? 'text-loss' : 'text-muted-foreground';
  const PnlIcon = pnl >= 0 ? TrendingUp : TrendingDown;

  const runtimeDegraded = status?.channelKind === 'runtime'
    && (status.circuitOpen || status.brokerHealthy === false);
  const showRuntimeAlert = status?.channelKind === 'runtime'
    && (status?.tradingBlocked || (status?.unresolvedAlertCount ?? 0) > 0 || runtimeDegraded);

  const fmtCurrency = (v: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(v);

  return (
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 !h-4" />

        {/* Runtime alert indicator */}
        {showRuntimeAlert && (
          <span className="relative flex h-2.5 w-2.5 mr-1">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-loss opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-loss" />
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
                <span className="text-xs text-warning tabular-nums">
                  {status.pendingTasks} pending
                </span>
              </>
            )}

            {runtimeDegraded && status?.lastError && (
              <>
                <Separator orientation="vertical" className="!h-3.5" />
                <span className="text-xs text-loss truncate max-w-[200px]" title={status.lastError}>
                  {status.lastError}
                </span>
              </>
            )}

            {statusError && (
              <>
                <Separator orientation="vertical" className="!h-3.5" />
                <span className="text-xs text-warning">{statusError}</span>
              </>
            )}
          </div>
        )}

        {!status && statusError && (
          <span className="text-xs text-warning">{statusError}</span>
        )}

        <div className="flex-1" />

        {/* Signal sheet trigger + Run scope + Theme */}
        <div className="flex items-center gap-1.5">
          <SignalSheet />
          <ChannelScopeSelector />
          <ThemeToggle />
        </div>
      </header>
  );
}
