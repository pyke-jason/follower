import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useChannelId } from '@/hooks/use-channel-id';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { queries } from '@/lib/queries';
import { formatCurrency } from '@/lib/format';
import { OverviewEquityCurve } from '@/components/overview-equity-curve';
import { AccountHero } from './account-hero';
import { PositionsWatchlist } from './positions-watchlist';
import { RiskPanel } from './risk-panel';
import { QueryBoundary, MetricStripSkeleton } from '@/components/query-boundary';
import { ArrowRight, AlertTriangle } from 'lucide-react';
import type { DashboardPageData } from '@/lib/page-adapters';

export default function OverviewPage() {
  const href = useScopedHref();
  const channelId = useChannelId();

  const query = useQuery(queries.dashboard.overview(channelId!));

  return (
    <QueryBoundary query={query} skeleton={<MetricStripSkeleton />}>
      {(data) => <DashboardContent data={data} href={href} channelId={channelId ?? ''} />}
    </QueryBoundary>
  );
}

function DashboardContent({ data, href, channelId }: {
  data: DashboardPageData;
  href: ReturnType<typeof useScopedHref>;
  channelId: string;
}) {
  const {
    openTrades, equityData, pendingReviews, riskSnapshot,
    stats, livePnlByTrade, accountBalance,
  } = data;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 h-full min-h-0">
      {/* ─── Left column: hero + chart + account details ─── */}
      <div className="flex flex-col gap-6 min-w-0 overflow-auto pb-6">
        {pendingReviews.length > 0 && (
          <Link
            to={href('/tasks?status=PENDING')}
            className="flex items-center gap-3 rounded-lg border border-warning/20 bg-warning/5 px-4 py-2.5 hover:bg-warning/10 transition-colors"
          >
            <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
            <span className="text-sm font-mono font-medium text-warning/80">
              {pendingReviews.length} task{pendingReviews.length !== 1 ? 's' : ''} pending review
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-warning/50 ml-auto" />
          </Link>
        )}

        <AccountHero
          balance={accountBalance}
          unrealizedPnl={stats.unrealizedPnl}
          realizedToday={stats.todayPnl}
          accountLabel={channelId}
        />

        {equityData.length > 1 ? (
          <div className="min-h-[300px]">
            <OverviewEquityCurve data={equityData} />
          </div>
        ) : (
          <div className="min-h-[200px] flex items-center justify-center border border-dashed border-border/40 rounded-lg">
            <p className="text-sm text-muted-foreground">
              Equity curve will appear once two or more daily balances are recorded.
            </p>
          </div>
        )}

        {/* Account details row — buying power, cash, margin */}
        {accountBalance && (
          <div className="border-t border-border/40 pt-4">
            <AccountDetails balance={accountBalance} />
          </div>
        )}

        {/* Risk / attention panel */}
        {riskSnapshot && (
          <div className="border-t border-border/40 pt-4">
            <RiskPanel data={riskSnapshot} />
          </div>
        )}
      </div>

      {/* ─── Right column: positions watchlist ─── */}
      <aside className="hidden lg:block h-full">
        <PositionsWatchlist trades={openTrades} livePnlByTrade={livePnlByTrade} />
      </aside>
    </div>
  );
}

function AccountDetails({ balance }: { balance: NonNullable<DashboardPageData['accountBalance']> }) {
  const rows: Array<{ label: string; value: string; muted?: boolean }> = [
    { label: 'Buying Power', value: formatCurrency(balance.buyingPower, 2) },
    { label: 'Cash', value: formatCurrency(balance.cashBalance, 2) },
    { label: 'Market Value', value: formatCurrency(balance.marketValue, 2) },
  ];
  if (balance.maintenanceMargin != null) {
    rows.push({ label: 'Margin Used', value: formatCurrency(balance.maintenanceMargin, 2) });
  }
  if (balance.cushion != null) {
    rows.push({
      label: 'Margin Cushion',
      value: `${(balance.cushion * 100).toFixed(1)}%`,
      muted: balance.cushion > 0.3,
    });
  }

  return (
    <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between border-b border-border/30 pb-1.5">
          <dt className="text-xs text-muted-foreground">{r.label}</dt>
          <dd className="text-sm font-mono tabular-nums font-medium">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
