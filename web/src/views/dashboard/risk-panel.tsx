import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/badge';
import { formatCurrency } from '@/lib/format';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { Link } from 'react-router-dom';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { AccountBalanceSnapshot } from '@/lib/page-adapters';

interface RiskData {
  equity: number;
  buyingPower: number;
  openPositions: number;
  maxPositions: number;
  drawdownPct: number;
  maxDrawdownPct: number;
  todayPnl: number;
  unresolvedAlerts: number;
  tradingBlocked: boolean;
}

export function RiskPanel({ data, balance }: { data: RiskData; balance: AccountBalanceSnapshot | null }) {
  const href = useScopedHref();
  const positionPct = (data.openPositions / data.maxPositions) * 100;
  const drawdownBarPct = (data.drawdownPct / data.maxDrawdownPct) * 100;
  const metrics: Array<{ label: string; value: string }> = [
    { label: 'Net liquidation', value: formatCurrency(balance?.equity ?? data.equity, 2) },
    { label: 'Cash', value: formatCurrency(balance?.cashBalance ?? 0, 2) },
    { label: 'Buying power', value: formatCurrency(balance?.buyingPower ?? data.buyingPower, 2) },
    { label: 'Market value', value: formatCurrency(balance?.marketValue ?? 0, 2) },
  ];
  if (balance?.maintenanceMargin != null) {
    metrics.push({ label: 'Margin used', value: formatCurrency(balance.maintenanceMargin, 2) });
  }
  if (balance?.cushion != null) {
    metrics.push({ label: 'Margin cushion', value: `${(balance.cushion * 100).toFixed(1)}%` });
  }

  return (
    <Card className={`py-0 gap-0 overflow-hidden ${data.tradingBlocked ? 'border-loss/30 bg-loss/5' : ''}`}>
      <CardContent className="p-0">
        {data.tradingBlocked && (
          <div className="flex items-center gap-2 text-loss px-4 py-3 border-b border-loss/15">
            <ShieldAlert className="h-3.5 w-3.5" />
            <Badge label="HALTED" />
            <span className="text-xs font-medium">Trading is blocked</span>
          </div>
        )}

        <dl className="grid grid-cols-2 xl:grid-cols-3">
          {metrics.map((metric) => (
            <div key={metric.label} className="flex items-baseline justify-between gap-3 border-b border-border/40 px-4 py-3">
              <dt className="text-xs text-muted-foreground">{metric.label}</dt>
              <dd className="text-sm font-mono tabular-nums font-medium">{metric.value}</dd>
            </div>
          ))}
        </dl>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 px-4 py-3">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Position capacity</span>
              <span className="tabular-nums text-foreground">{data.openPositions}/{data.maxPositions}</span>
            </div>
            <Progress
              value={positionPct}
              className={`h-1.5 ${positionPct > 80 ? '[&>div]:bg-warning' : ''}`}
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Drawdown</span>
              <span className={`tabular-nums font-medium ${data.drawdownPct >= 4 ? 'text-loss' : data.drawdownPct >= 3 ? 'text-warning' : 'text-foreground'}`}>
                {data.drawdownPct.toFixed(1)}%/{data.maxDrawdownPct}%
              </span>
            </div>
            <Progress
              value={drawdownBarPct}
              className={`h-1.5 ${data.drawdownPct >= 4 ? '[&>div]:bg-loss' : data.drawdownPct >= 3 ? '[&>div]:bg-warning' : ''}`}
            />
          </div>
        </div>

        {data.unresolvedAlerts > 0 && (
          <Link
            to={href('/reconciliation')}
            className="flex items-center gap-2 text-xs text-warning hover:text-warning/80 transition-colors px-4 py-3 border-t border-border/50"
          >
            <AlertTriangle className="h-3 w-3" />
            <span>{data.unresolvedAlerts} unresolved recon alert{data.unresolvedAlerts !== 1 ? 's' : ''}</span>
            <span className="ml-auto text-muted-foreground">View →</span>
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
