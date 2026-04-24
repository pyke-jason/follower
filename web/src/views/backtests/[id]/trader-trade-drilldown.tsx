import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { formatCurrency, formatDate, formatInteger } from '@/lib/format';
import { computeTradeCommission } from '@src/lib/commission';
import { safeParseFloat } from '@src/lib/numbers';
import { formatLegsSummary } from '@src/lib/trade';
import { summarizeTradeRiskAtEntry } from '@src/lib/trade-risk';
import type { CommissionSchedule, Trade } from '@src/db/schema';

const MAX_CHART_TRADES = 24;

type TraderTradeDrilldownProps = {
  trader: string;
  trades: Trade[];
  commissionSchedule?: CommissionSchedule;
  onClear: () => void;
};

type TradeBarPoint = {
  id: string;
  label: string;
  pnl: number;
  status: string;
  symbol: string;
  strategy: string;
  openedAt: string | null;
  closedAt: string | null;
  riskNote: string;
  maxLoss: number | null;
};

function buildTradeLabel(trade: Trade): string {
  const legsSummary = formatLegsSummary(trade.legs, trade.strategy);
  return `${trade.symbol}${legsSummary ? ` ${legsSummary}` : ` ${trade.strategy}`}`;
}

function DrilldownTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: TradeBarPoint }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-foreground">{point.label}</div>
      <div className="mt-1 text-muted-foreground">
        P&amp;L: <span className={point.pnl >= 0 ? 'text-profit' : 'text-loss'}>{formatCurrency(point.pnl)}</span>
      </div>
      <div className="text-muted-foreground">Opened: {formatDate(point.openedAt)}</div>
      <div className="text-muted-foreground">Closed: {formatDate(point.closedAt)}</div>
      <div className="mt-1 text-muted-foreground">
        Max loss at entry:{' '}
        <span className="text-foreground">
          {point.maxLoss != null ? formatCurrency(point.maxLoss) : 'Unbounded / missing stop'}
        </span>
      </div>
      <div className="mt-1 max-w-72 text-muted-foreground">{point.riskNote}</div>
    </div>
  );
}

export function TraderTradeDrilldown({
  trader,
  trades,
  commissionSchedule,
  onClear,
}: TraderTradeDrilldownProps) {
  const traderTrades = useMemo(
    () => trades.filter((trade) => trade.trader === trader),
    [trader, trades],
  );

  const openTrades = useMemo(
    () => traderTrades
      .filter((trade) => trade.status === 'OPEN')
      .sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? '')),
    [traderTrades],
  );

  const closedTrades = useMemo(
    () => traderTrades
      .filter((trade) => trade.status === 'CLOSED' && trade.pnl != null)
      .sort((a, b) => (b.closedAt ?? b.openedAt ?? '').localeCompare(a.closedAt ?? a.openedAt ?? '')),
    [traderTrades],
  );

  const chartTrades = useMemo<TradeBarPoint[]>(
    () => closedTrades.slice(0, MAX_CHART_TRADES).map((trade) => {
      const grossPnl = safeParseFloat(trade.pnl);
      const commission = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
      const risk = summarizeTradeRiskAtEntry(trade);
      return {
        id: trade.id,
        label: buildTradeLabel(trade),
        pnl: grossPnl - commission,
        status: trade.status,
        symbol: trade.symbol,
        strategy: trade.strategy,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        riskNote: risk.note,
        maxLoss: risk.maxLoss,
      };
    }),
    [closedTrades, commissionSchedule],
  );

  const knownRiskTrades = chartTrades.filter((trade) => trade.maxLoss != null);
  const knownRiskSum = knownRiskTrades.reduce((sum, trade) => sum + (trade.maxLoss ?? 0), 0);
  const netPnl = chartTrades.reduce((sum, trade) => sum + trade.pnl, 0);

  return (
    <Card className="py-0 gap-0">
      <CardHeader className="border-b py-3 px-4">
        <div className="flex items-center gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm">Trader Detail: {trader}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Recent closed trades by P&amp;L. Tooltip shows theoretical max loss at entry where the trade shape defines it.
            </p>
          </div>
          <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={onClear} aria-label="Clear trader detail">
            <X className="size-3" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4 px-4 pb-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span>Trades: <span className="font-medium text-foreground">{formatInteger(traderTrades.length)}</span></span>
          <span>Open: <span className="font-medium text-foreground">{formatInteger(openTrades.length)}</span></span>
          <span>Recent P&amp;L: <span className={netPnl >= 0 ? 'font-medium text-profit' : 'font-medium text-loss'}>{formatCurrency(netPnl)}</span></span>
          <span>Shown max-loss sum: <span className="font-medium text-foreground">{formatCurrency(knownRiskSum)}</span></span>
          <span>Known risk trades: <span className="font-medium text-foreground">{knownRiskTrades.length}/{chartTrades.length}</span></span>
        </div>

        {openTrades.length > 0 && (
          <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Still open:</span>{' '}
            {openTrades.map((trade) => `${buildTradeLabel(trade)} since ${formatDate(trade.openedAt)}`).join(' • ')}
          </div>
        )}

        {closedTrades.length === 0 ? (
          <EmptyState
            title={`No closed trades for ${trader}`}
            hint="Open positions still appear above when they linger."
            className="py-12"
          />
        ) : (
          <div>
            {closedTrades.length > MAX_CHART_TRADES && (
              <p className="mb-3 text-xs text-muted-foreground">
                Showing the most recent {MAX_CHART_TRADES} of {closedTrades.length} closed trades.
              </p>
            )}
            <ResponsiveContainer width="100%" height={Math.max(220, chartTrades.length * 34)}>
              <BarChart
                data={chartTrades}
                layout="vertical"
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  type="number"
                  tickFormatter={formatCurrency}
                  tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
                  axisLine={{ stroke: 'var(--color-border)' }}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={140}
                />
                <Tooltip content={<DrilldownTooltip />} />
                <Bar dataKey="pnl" radius={[4, 4, 4, 4]}>
                  {chartTrades.map((trade) => (
                    <Cell
                      key={trade.id}
                      fill={trade.pnl >= 0 ? 'var(--color-profit)' : 'var(--color-loss)'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
