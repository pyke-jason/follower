import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from './badge';
import { formatCurrency } from '@/lib/format';
import Link from 'next/link';
import { AlertTriangle, ShieldAlert } from 'lucide-react';

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

export function RiskPanel({ data }: { data: RiskData }) {
  const positionPct = (data.openPositions / data.maxPositions) * 100;
  const drawdownBarPct = (data.drawdownPct / data.maxDrawdownPct) * 100;

  return (
    <Card className={`py-3 px-4 gap-0 ${data.tradingBlocked ? 'border-red-500/50 bg-red-950/20' : ''}`}>
      <CardContent className="p-0 space-y-2.5">
        {data.tradingBlocked && (
          <div className="flex items-center gap-2 text-red-400">
            <ShieldAlert className="h-3.5 w-3.5" />
            <Badge label="HALTED" />
            <span className="text-xs font-medium">Trading is blocked</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2.5">
          {/* Positions */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Positions</span>
              <span className="tabular-nums text-foreground">{data.openPositions}/{data.maxPositions}</span>
            </div>
            <Progress
              value={positionPct}
              className={`h-1.5 ${positionPct > 80 ? '[&>div]:bg-amber-500' : ''}`}
            />
          </div>

          {/* Buying Power */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Buying Power</span>
            <span className="tabular-nums text-foreground font-medium">{formatCurrency(data.buyingPower)}</span>
          </div>

          {/* Drawdown */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Drawdown</span>
              <span className={`tabular-nums font-medium ${data.drawdownPct >= 4 ? 'text-red-400' : data.drawdownPct >= 3 ? 'text-amber-400' : 'text-foreground'}`}>
                {data.drawdownPct.toFixed(1)}%/{data.maxDrawdownPct}%
              </span>
            </div>
            <Progress
              value={drawdownBarPct}
              className={`h-1.5 ${data.drawdownPct >= 4 ? '[&>div]:bg-red-500' : data.drawdownPct >= 3 ? '[&>div]:bg-amber-500' : ''}`}
            />
          </div>

          {/* Equity */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Equity</span>
            <span className="tabular-nums text-foreground font-medium">{formatCurrency(data.equity)}</span>
          </div>
        </div>

        {/* Recon alerts */}
        {data.unresolvedAlerts > 0 && (
          <Link
            href="/reconciliation"
            className="flex items-center gap-2 text-xs text-amber-400 hover:text-amber-300 transition-colors pt-1 border-t border-border/50"
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
