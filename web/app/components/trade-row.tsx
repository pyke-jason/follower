import { Link } from 'react-router-dom';
import { ChevronRight, Timer, Scissors, TrendingDown, Plus, ArrowLeftRight, XCircle, MessageSquareMore, Zap } from 'lucide-react';
import { TableRow, TableCell } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { formatCurrency, formatDate } from '@/lib/format';
import { fmtMs } from './decision-shared';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { safeParseFloat } from '@src/lib/numbers';
import { computeTradeCommission } from '@src/lib/commission';
import { formatLegsSummary } from '@src/lib/trade';
import type { TradeFlag } from '@src/db/schema';
import { useTradesStore } from '@/stores/trades-store';
import type { LucideIcon } from 'lucide-react';

const FLAG_ICONS: Record<string, { icon: LucideIcon; tooltip: string; severity: 'muted' | 'warn' | 'danger' }> = {
  autoClose: { icon: Timer, tooltip: 'Auto-closed — no exit signal from trader', severity: 'warn' },
  legOff: { icon: Scissors, tooltip: 'Had a leg removed — spread became single-leg', severity: 'warn' },
  trim: { icon: TrendingDown, tooltip: 'Position was partially exited', severity: 'muted' },
  add: { icon: Plus, tooltip: 'Position was scaled into', severity: 'muted' },
  slippage: { icon: ArrowLeftRight, tooltip: 'Significant slippage detected', severity: 'warn' },
  closeFailed: { icon: XCircle, tooltip: 'A close order was cancelled without filling', severity: 'danger' },
  marketDataFail: { icon: XCircle, tooltip: 'Market data fetch failed for this trade', severity: 'danger' },
  hasUpdate: { icon: MessageSquareMore, tooltip: 'Trader posted about this symbol after opening', severity: 'muted' },
};

const SEVERITY_COLOR = {
  muted: 'text-muted-foreground/50 hover:text-muted-foreground',
  warn: 'text-amber-400/60 hover:text-amber-400',
  danger: 'text-rose-400/60 hover:text-rose-400',
};

function FlagIcon({ flag, tooltip }: { flag: string; tooltip?: string }) {
  const def = FLAG_ICONS[flag];
  if (!def) return null;
  const Icon = def.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Icon className={`h-3 w-3 transition-colors ${SEVERITY_COLOR[def.severity]}`} />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-60 text-xs">
        {tooltip ?? def.tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export function TradeRow({
  tradeId,
  onExpand,
  isExpanded,
}: {
  tradeId: string;
  onExpand?: () => void;
  isExpanded?: boolean;
}) {
  const trade = useTradesStore((s) => s.trades.find((t) => t.id === tradeId));
  const events = useTradesStore((s) => s.eventsByTradeId[tradeId]) ?? [];
  const flags: TradeFlag[] = useTradesStore((s) => s.flagsByTradeId[tradeId]) ?? [];
  const commissionSchedule = useTradesStore((s) => s.commissionSchedule);
  const href = useScopedHref();

  if (!trade) return null;

  const grossPnl = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
  const comm = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
  const pnl = grossPnl != null ? grossPnl - comm : null;

  // Entry price for % return calc
  const entry = trade.entryPrice != null ? safeParseFloat(trade.entryPrice) : null;
  const pnlPct = pnl != null && entry != null && entry !== 0 && trade.quantity
    ? (pnl / (entry * trade.quantity)) * 100
    : null;

  // Row border — the ONE use of color to encode outcome
  const rowBorder = pnl != null && pnl !== 0
    ? pnl > 0 ? 'border-l-2 border-l-profit/60' : 'border-l-2 border-l-loss/60'
    : '';

  // Contract description (legs summary for options/spreads)
  const openEvent = events.find(e => e.action === 'OPEN');
  const openLegs = openEvent ? openEvent.legs : trade.legs;
  const openStrategy = openEvent?.strategy ?? trade.strategy;
  const legsSummary = formatLegsSummary(openLegs, openStrategy);
  const isOption = trade.strategy !== 'STOCK';

  // Chase slippage from metadata (recorded at write time)
  const meta = trade.metadata as Record<string, unknown> | null;
  const entrySlippage = typeof meta?.entrySlippage === 'number' ? meta.entrySlippage : null;
  const exitSlippage = typeof meta?.exitSlippage === 'number' ? meta.exitSlippage : null;
  const totalSlippage = (entrySlippage ?? 0) + (exitSlippage ?? 0);
  const hasSlippage = entrySlippage != null || exitSlippage != null;
  const slippagePct = entry && totalSlippage !== 0 ? Math.abs(totalSlippage / entry) * 100 : null;
  // 0→5% maps to 0→1 for color, 5→15% maps to 0→1 for glow/emphasis
  const slippageIntensity = slippagePct != null ? Math.min(slippagePct / 5, 1) : 0;
  const slippageEmphasis = slippagePct != null ? Math.min(Math.max((slippagePct - 5) / 10, 0), 1) : 0;

  // Slippage tooltip (flag-based — from fill enrichment, direction-aware)
  const brokerFill = trade.brokerFillPrice != null ? safeParseFloat(trade.brokerFillPrice) : null;
  const isLong = trade.direction === 'LONG';
  const fillDelta = entry && brokerFill
    ? (isLong ? brokerFill - entry : entry - brokerFill)
    : null;
  const fillDeltaPct = entry && fillDelta ? Math.abs(fillDelta / entry) : null;
  const slippageTooltip = fillDelta != null
    ? fillDelta > 0
      ? `Slippage: +${formatCurrency(fillDelta)} (${(fillDeltaPct! * 100).toFixed(1)}%) — entry est. ${formatCurrency(entry)} vs fill ${formatCurrency(brokerFill)}`
      : `Price improvement: ${formatCurrency(Math.abs(fillDelta))} (${(fillDeltaPct! * 100).toFixed(1)}%) — entry est. ${formatCurrency(entry)} vs fill ${formatCurrency(brokerFill)}`
    : undefined;

  // Chase steps
  const chaseSteps = events.reduce((sum, e) => {
    const steps = (e.metadata as Record<string, unknown>)?.chaseSteps;
    return sum + (typeof steps === 'number' ? steps : 0);
  }, 0);
  const chaseSeverity = flags.includes('chaseDanger') ? 'danger' : flags.includes('chaseWarn') ? 'warn' : 'muted';

  // Active flags (excluding chase which is handled separately)
  const activeFlags = flags.filter(f => f !== 'chaseWarn' && f !== 'chaseDanger' && FLAG_ICONS[f]);

  return (
    <TableRow
      data-trade-id={tradeId}
      className={`hover:bg-accent/40 transition-colors ${onExpand ? 'cursor-pointer' : ''} ${isExpanded ? 'bg-background' : ''} ${rowBorder}`}
      onClick={onExpand}
    >
      {/* Expand chevron */}
      <TableCell className="w-6 pr-0">
        {onExpand ? (
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground/40 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
        ) : null}
      </TableCell>

      {/* Trade: LONG AAPL 230C 9/12 */}
      <TableCell>
        <span className="inline-flex items-center gap-3">
          <Link
            to={href(`/trades/${trade.id}`)}
            className="text-foreground font-medium text-sm hover:underline underline-offset-2 decoration-muted-foreground/30"
            onClick={(e) => e.stopPropagation()}
          >
            {trade.direction} {trade.symbol}{legsSummary ? ` ${legsSummary}` : isOption ? ` ${trade.strategy}` : ''}
          </Link>

          {/* Flag icons */}
          {activeFlags.length > 0 && (
            <span className="inline-flex items-center gap-1">
              {activeFlags.map((f) => (
                <FlagIcon key={f} flag={f} tooltip={f === 'slippage' ? slippageTooltip : undefined} />
              ))}
            </span>
          )}

          {/* Chase icon + slippage */}
          {(chaseSteps > 0 || hasSlippage) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={`inline-flex items-center gap-0.5 transition-colors ${slippageEmphasis > 0 ? 'rounded-sm px-1' : ''}`}
                  style={hasSlippage && slippageIntensity > 0
                    ? {
                        color: `color-mix(in oklab, rgb(239 68 68) ${Math.round(slippageIntensity * 100)}%, rgb(161 161 170))`,
                        ...(slippageEmphasis > 0 ? {
                          fontWeight: Math.round(400 + slippageEmphasis * 500),
                          backgroundColor: `rgb(239 68 68 / ${(slippageEmphasis * 0.25).toFixed(2)})`,
                          boxShadow: `0 0 ${Math.round(slippageEmphasis * 16)}px rgb(239 68 68 / ${(slippageEmphasis * 0.5).toFixed(2)}), 0 0 ${Math.round(slippageEmphasis * 40)}px rgb(239 68 68 / ${(slippageEmphasis * 0.2).toFixed(2)})`,
                          textShadow: `0 0 ${Math.round(slippageEmphasis * 10)}px rgb(239 68 68 / ${(slippageEmphasis * 0.9).toFixed(2)}), 0 0 ${Math.round(slippageEmphasis * 30)}px rgb(239 68 68 / ${(slippageEmphasis * 0.5).toFixed(2)})`,
                          outline: slippageEmphasis > 0.3 ? `1px solid rgb(239 68 68 / ${(slippageEmphasis * 0.5).toFixed(2)})` : undefined,
                        } : {}),
                      }
                    : undefined
                  }
                >
                  <Zap className="h-3 w-3" />
                  {hasSlippage && totalSlippage !== 0 && (
                    <span className="text-[10px] tabular-nums">
                      {formatCurrency(Math.abs(totalSlippage))}
                      {slippagePct != null && (
                        <span className="ml-0.5">({slippagePct.toFixed(1)}%)</span>
                      )}
                    </span>
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs space-y-0.5">
                {chaseSteps > 0 && (
                  <div>{chaseSteps} chase step{chaseSteps > 1 ? 's' : ''}</div>
                )}
                {entrySlippage != null && (
                  <div>Entry slippage: {formatCurrency(Math.abs(entrySlippage))}</div>
                )}
                {exitSlippage != null && (
                  <div>Exit slippage: {formatCurrency(Math.abs(exitSlippage))}</div>
                )}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      </TableCell>

      {/* Trader */}
      <TableCell>
        <Link
          to={href(`/traders/${encodeURIComponent(trade.trader)}`)}
          className="text-muted-foreground text-xs hover:text-foreground hover:underline underline-offset-2 decoration-muted-foreground/30 transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          {trade.trader}
        </Link>
      </TableCell>

      {/* Qty */}
      <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
        {trade.quantity ?? 1}
      </TableCell>

      {/* Entry → Exit */}
      <TableCell className="text-right tabular-nums text-xs">
        <span className="whitespace-nowrap">
          <span className="text-muted-foreground">{formatCurrency(trade.entryPrice)}</span>
          {trade.exitPrice != null && (
            <>
              <span className="text-muted-foreground/30 mx-0.5">&rarr;</span>
              <span className="text-muted-foreground">{formatCurrency(trade.exitPrice)}</span>
            </>
          )}
        </span>
      </TableCell>

      {/* P&L — the star column */}
      <TableCell className="text-right tabular-nums">
        {pnl != null ? (
          <div className="whitespace-nowrap">
            <span className={`font-medium text-sm ${pnl > 0 ? 'text-profit' : pnl < 0 ? 'text-loss' : 'text-muted-foreground'}`}>
              {formatCurrency(pnl)}
            </span>
            {pnlPct != null && (
              <span className="text-[10px] text-muted-foreground/50 ml-1">
                {pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(0)}%
              </span>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground/40">--</span>
        )}
      </TableCell>

      {/* Opened */}
      <TableCell className="text-muted-foreground/60 text-xs">
        {formatDate(trade.openedAt)}
      </TableCell>

      {/* Execution time */}
      <TableCell className="text-right tabular-nums text-[10px] text-muted-foreground/50">
        {typeof meta?.executionMs === 'number' ? fmtMs(meta.executionMs) : null}
      </TableCell>
    </TableRow>
  );
}
