import { Link, useLocation } from 'react-router-dom';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { SignalSheet } from './signal-sheet';
import { ThemeToggle } from './theme-toggle';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { formatCurrency, pnlColor } from '@/lib/format';
import { useChannelId } from '@/hooks/use-channel-id';
import { useChannelStatus } from '@/lib/queries';

/** Map top-level route segments to human-readable labels. */
const segmentLabels: Record<string, string> = {
  traders: 'Traders',
  trades: 'Trades',
  tasks: 'Tasks',
  messages: 'Messages',
  backtests: 'Backtests',
  reconciliation: 'Reconciliation',
  eval: 'Eval',
  review: 'Review',
  settings: 'Settings',
  architecture: 'Architecture',
  new: 'New',
};

function useBreadcrumbs(): { label: string; href: string }[] {
  const { pathname } = useLocation();
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return [];

  const crumbs: { label: string; href: string }[] = [];
  let accumulated = '';
  for (const seg of segments) {
    accumulated += `/${seg}`;
    const label = segmentLabels[seg] ?? decodeURIComponent(seg);
    crumbs.push({ label, href: accumulated });
  }
  return crumbs;
}

export function TopBar() {
  const channelId = useChannelId();
  const statusQuery = useChannelStatus(channelId);
  const status = statusQuery.data ?? null;
  const statusError = statusQuery.isError ? 'Status unavailable' : null;
  const crumbs = useBreadcrumbs();

  // Runtime channels: show live unrealized P&L (what the trader cares about intra-day).
  // Backtest channels: show realized total P&L from closed trades in the run.
  const isRuntime = status?.channelKind === 'runtime';
  const primaryPnl = isRuntime ? (status?.unrealizedPnl ?? 0) : (status?.todayPnl ?? 0);
  const primaryLabel = isRuntime ? 'unrealized' : 'P&L';
  const realizedToday = isRuntime ? (status?.todayPnl ?? 0) : 0;
  const pnlSign = primaryPnl >= 0 ? '+' : '';
  const pnlCls = pnlColor(primaryPnl);
  const PnlIcon = primaryPnl >= 0 ? TrendingUp : TrendingDown;

  const runtimeDegraded = status?.channelKind === 'runtime'
    && (status.circuitOpen || status.brokerHealthy === false);
  const showRuntimeAlert = status?.channelKind === 'runtime'
    && (status?.tradingBlocked || (status?.unresolvedAlertCount ?? 0) > 0 || runtimeDegraded);

  return (
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 !h-4" />

        {/* Breadcrumbs */}
        {crumbs.length > 0 && (
          <Breadcrumb>
            <BreadcrumbList>
              {crumbs.map((crumb, i) => {
                const isLast = i === crumbs.length - 1;
                return (
                  <BreadcrumbItem key={crumb.href}>
                    {i > 0 && <BreadcrumbSeparator />}
                    {isLast ? (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link to={crumb.href}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        )}

        <div className="flex-1" />

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
            {/* P&L — live unrealized for runtime, realized for backtest */}
            <div
              className="flex items-center gap-1.5"
              title={isRuntime ? 'Unrealized P&L across all open positions (live from broker)' : 'Realized P&L'}
            >
              <PnlIcon className={`h-3.5 w-3.5 ${pnlCls}`} />
              <span className={`text-sm font-mono font-semibold tabular-nums ${pnlCls}`}>
                {pnlSign}
                {formatCurrency(primaryPnl, 0)}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
                {primaryLabel}
              </span>
            </div>

            {/* Realized-today secondary badge for runtime channels */}
            {isRuntime && (
              <span
                className={`text-xs font-mono tabular-nums ${realizedToday === 0 ? 'text-muted-foreground/50' : pnlColor(realizedToday)}`}
                title="Realized P&L from trades closed today"
              >
                {realizedToday > 0 ? '+' : ''}
                {formatCurrency(realizedToday, 0)} realized
              </span>
            )}

            {/* Open positions */}
            {status.openTrades > 0 && (
              <>
                <Separator orientation="vertical" className="!h-3.5" />
                <span className="text-xs font-mono text-muted-foreground tabular-nums">
                  {status.openTrades} open
                </span>
              </>
            )}

            {/* Pending tasks */}
            {status.pendingTasks > 0 && (
              <>
                <Separator orientation="vertical" className="!h-3.5" />
                <span className="text-xs font-mono text-warning tabular-nums">
                  {status.pendingTasks} pending
                </span>
              </>
            )}

            {runtimeDegraded && status?.lastError && (
              <>
                <Separator orientation="vertical" className="!h-3.5" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-xs text-loss truncate max-w-[200px]">
                      {status.lastError}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{status.lastError}</TooltipContent>
                </Tooltip>
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

        {/* Signal sheet trigger + Theme */}
        <div className="flex items-center gap-1.5">
          <SignalSheet />
          <ThemeToggle />
        </div>
      </header>
  );
}
