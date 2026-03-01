import { getClosedTrades, getTradeHistorySummary, getRunCommissionSchedule, getTradeEventsForTrades, getCancelledCloseTradeIds } from '@/lib/queries';
import { TradesTableClient } from '../components/trades-table-client';
import { TradesHydrator } from './trades-hydrator';
import { MetricStrip } from '../components/metric-strip';
import type { Metric } from '../components/metric-strip';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { buildHref } from '@/lib/run-scope';
import Link from 'next/link';
import { Filter, X } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function TradeHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ trader?: string; symbol?: string; strategy?: string; page?: string; run?: string }>;
}) {
  const params = await searchParams;
  const runId = params.run;
  const page = parseInt(params.page ?? '1');
  const limit = 50;
  const offset = (page - 1) * limit;

  const hasFilters = !!(params.trader || params.symbol || params.strategy);

  const [trades, summary, commissionSchedule] = await Promise.all([
    getClosedTrades({
      trader: params.trader,
      symbol: params.symbol,
      strategy: params.strategy,
      limit,
      offset,
      runId,
    }),
    getTradeHistorySummary({
      trader: params.trader,
      symbol: params.symbol,
      strategy: params.strategy,
      runId,
    }),
    runId ? getRunCommissionSchedule(runId) : undefined,
  ]);

  const [eventsByTradeId, cancelledTradeIds] = await Promise.all([
    getTradeEventsForTrades(trades.map((t) => t.id)),
    getCancelledCloseTradeIds(trades.map((t) => t.id)),
  ]);

  const metrics: Metric[] = [
    {
      label: 'Total P&L',
      value: summary.totalPnl,
      format: 'currency',
      colorBySign: true,
    },
    {
      label: 'Trades',
      value: summary.totalTrades,
      format: 'integer',
    },
    {
      label: 'Win Rate',
      value: summary.winRate,
      format: 'percent',
    },
    {
      label: 'Best Trade',
      value: summary.bestTrade,
      format: 'currency',
      colorBySign: true,
    },
    {
      label: 'Worst Trade',
      value: summary.worstTrade,
      format: 'currency',
      colorBySign: true,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Trade History</h2>
      </div>

      {/* Summary strip */}
      {summary.totalTrades > 0 && (
        <MetricStrip metrics={metrics} />
      )}

      {/* Filters */}
      <div className="flex items-center gap-2">
        <form className="flex gap-2 items-center">
          {runId && <input type="hidden" name="run" value={runId} />}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Filter className="h-3.5 w-3.5" />
          </div>
          <Input
            name="trader"
            placeholder="Trader"
            defaultValue={params.trader ?? ''}
            className="w-28 h-8 text-xs"
          />
          <Input
            name="symbol"
            placeholder="Symbol"
            defaultValue={params.symbol ?? ''}
            className="w-24 h-8 text-xs"
          />
          <Input
            name="strategy"
            placeholder="Strategy"
            defaultValue={params.strategy ?? ''}
            className="w-24 h-8 text-xs"
          />
          <Button type="submit" variant="secondary" size="xs">
            Filter
          </Button>
        </form>
        {hasFilters && (
          <Button variant="ghost" size="xs" asChild className="text-muted-foreground">
            <Link href={buildHref('/trades', runId)}>
              <X className="h-3 w-3 mr-1" />
              Clear
            </Link>
          </Button>
        )}
      </div>

      <div className="animate-in-up">
        <TradesHydrator data={{ trades, eventsByTradeId, cancelledTradeIds, commissionSchedule, runId }} />
        <TradesTableClient />
        {trades.length === 0 && hasFilters && (
          <p className="px-4 py-6 text-sm text-muted-foreground text-center">
            No closed trades matching filters
          </p>
        )}
      </div>

      <div className="flex gap-2 justify-center items-center">
        {page > 1 && (
          <Button variant="ghost" size="sm" asChild>
            <Link
              href={buildHref(`/trades?page=${page - 1}${params.trader ? `&trader=${params.trader}` : ''}${params.symbol ? `&symbol=${params.symbol}` : ''}${params.strategy ? `&strategy=${params.strategy}` : ''}`, runId)}
            >
              Previous
            </Link>
          </Button>
        )}
        <span className="text-sm text-muted-foreground tabular-nums">Page {page}</span>
        {trades.length === limit && (
          <Button variant="ghost" size="sm" asChild>
            <Link
              href={buildHref(`/trades?page=${page + 1}${params.trader ? `&trader=${params.trader}` : ''}${params.symbol ? `&symbol=${params.symbol}` : ''}${params.strategy ? `&strategy=${params.strategy}` : ''}`, runId)}
            >
              Next
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
