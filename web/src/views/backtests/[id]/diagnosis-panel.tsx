import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, type CardTone } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useSearchParam } from '@/hooks/use-search-param';
import { formatCurrency, formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import { contractMultiplier, tradeQty } from '@src/lib/trade';
import { safeParseFloat } from '@src/lib/numbers';
import type { Trade } from '@src/db/schema';

export type DiagnosisBucket = 'holding' | 'wheel-expiry' | 'within-window' | 'past-plan';

const BUCKET_DEFINITIONS: ReadonlyArray<{
  id: DiagnosisBucket;
  label: string;
  description: string;
  tone?: CardTone;
}> = [
  {
    id: 'holding',
    label: 'Long-term holds',
    description: 'Stock with no defined exit.',
  },
  {
    id: 'wheel-expiry',
    label: 'Awaiting expiry',
    description: 'Short single-leg options waiting on expiration.',
  },
  {
    id: 'within-window',
    label: 'Within plan',
    description: 'Open positions still inside their planned exit window.',
  },
  {
    id: 'past-plan',
    label: 'Past planned exit',
    description: 'Planned exit has passed but position is still open.',
    tone: 'warning',
  },
];

/** Capital-at-risk per trade. Prefer metadata.risk.peakRisk; fall back to notional. */
function capitalAtRisk(trade: Trade): number {
  const peak = trade.metadata?.risk?.peakRisk;
  if (typeof peak === 'number' && Number.isFinite(peak)) return peak;
  const entry = trade.entryPrice != null ? safeParseFloat(trade.entryPrice) : null;
  if (entry == null || !Number.isFinite(entry)) return 0;
  const qty = tradeQty(trade.quantity);
  return Math.abs(entry) * qty * contractMultiplier(trade.strategy);
}

function classifyTrade(trade: Trade, endIso: string): DiagnosisBucket | null {
  if (trade.status !== 'OPEN') return null;
  const planned = trade.plannedExitDate;

  if (trade.strategy === 'STOCK' && planned == null) return 'holding';

  const isShortSingleOption =
    (trade.strategy === 'CALL' || trade.strategy === 'PUT') && trade.direction === 'SHORT';

  if (isShortSingleOption && planned != null && planned >= endIso) {
    return 'wheel-expiry';
  }

  if (planned != null && planned < endIso) return 'past-plan';
  // null planned exit (no defensible date) or planned date still in the future.
  return 'within-window';
}

type DiagnosisBucketSummary = {
  id: DiagnosisBucket;
  label: string;
  description: string;
  tone?: CardTone;
  count: number;
  capitalAtRisk: number;
};

type DiagnosisResult = {
  buckets: DiagnosisBucketSummary[];
  byTradeId: Record<string, DiagnosisBucket>;
};

export function bucketTrades(trades: Trade[], endIso: string): DiagnosisResult {
  const counts: Record<DiagnosisBucket, { count: number; capitalAtRisk: number }> = {
    'holding': { count: 0, capitalAtRisk: 0 },
    'wheel-expiry': { count: 0, capitalAtRisk: 0 },
    'within-window': { count: 0, capitalAtRisk: 0 },
    'past-plan': { count: 0, capitalAtRisk: 0 },
  };
  const byTradeId: Record<string, DiagnosisBucket> = {};

  for (const trade of trades) {
    const bucket = classifyTrade(trade, endIso);
    if (!bucket) continue;
    byTradeId[trade.id] = bucket;
    counts[bucket].count += 1;
    counts[bucket].capitalAtRisk += capitalAtRisk(trade);
  }

  const buckets = BUCKET_DEFINITIONS.map((def) => ({
    ...def,
    count: counts[def.id].count,
    capitalAtRisk: counts[def.id].capitalAtRisk,
  }));

  return { buckets, byTradeId };
}

type DiagnosisPanelProps = {
  trades: Trade[];
  endIso: string;
};

export function DiagnosisPanel({ trades, endIso }: DiagnosisPanelProps) {
  const [selected, setSelected] = useSearchParam('diagnosis');
  const result = useMemo(() => bucketTrades(trades, endIso), [trades, endIso]);

  // Unrealized P&L per bucket would require a per-trade mark; the static
  // backtest payload does not include marks for open positions, so we only
  // surface count + capital-at-risk here.
  return (
    <div className="space-y-2">
      {result.buckets.map((bucket) => {
        const isSelected = selected === bucket.id;
        const isEmpty = bucket.count === 0;
        return (
          <Card
            key={bucket.id}
            tone={bucket.tone}
            className={cn(
              'gap-0 py-0 transition-colors',
              isSelected && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
              isEmpty && 'opacity-60',
            )}
          >
            <CardHeader className="px-3 pt-2 pb-0 flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-xs font-medium">{bucket.label}</CardTitle>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 px-2 text-[10px]"
                disabled={isEmpty}
                onClick={() => setSelected(isSelected ? null : bucket.id)}
                aria-pressed={isSelected}
              >
                {isSelected ? 'clear' : 'view'}
              </Button>
            </CardHeader>
            <CardContent className="px-3 pb-2 pt-1">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    'text-xl font-semibold tabular-nums',
                    bucket.tone === 'warning' && bucket.count > 0 && 'text-warning',
                  )}
                >
                  {formatInteger(bucket.count)}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {formatCurrency(bucket.capitalAtRisk, 0)} at risk
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground/80 mt-0.5">{bucket.description}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
