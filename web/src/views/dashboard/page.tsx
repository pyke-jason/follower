import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useChannelId } from '@/hooks/use-channel-id';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { queries } from '@/lib/queries';
import { OverviewUnrealizedCurve } from '@/components/overview-equity-curve';
import { AccountHero } from './account-hero';
import { PositionsWatchlist } from './positions-watchlist';
import { QualitySnapshotPanel } from './quality-snapshot-panel';
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
    openTrades, unrealizedData, pendingReviews, riskSnapshot,
    stats, qualitySummary, livePositionsByTradeId, accountBalance,
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
          openTrades={stats.openTrades}
          accountLabel={channelId}
        />

        {unrealizedData.length > 1 ? (
          <div className="min-h-[300px]">
            <OverviewUnrealizedCurve data={unrealizedData} />
          </div>
        ) : (
          <div className="min-h-[200px] flex items-center justify-center border border-dashed border-border/40 rounded-lg">
            <p className="text-sm text-muted-foreground">
              Unrealized P&L history will appear once two or more snapshots are recorded.
            </p>
          </div>
        )}

        {riskSnapshot && (
          <div className="border-t border-border/40 pt-4">
            <RiskPanel data={riskSnapshot} balance={accountBalance} />
          </div>
        )}

        <div className="border-t border-border/40 pt-4">
          <QualitySnapshotPanel summary={qualitySummary} />
        </div>
      </div>

      {/* ─── Right column: positions watchlist ─── */}
      <aside className="hidden lg:block h-full">
        <PositionsWatchlist trades={openTrades} livePositionsByTradeId={livePositionsByTradeId} />
      </aside>
    </div>
  );
}
