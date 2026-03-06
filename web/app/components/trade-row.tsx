import { Link } from 'react-router-dom';
import { ChevronRight, ArrowUp, ArrowDown, Timer, Scissors, TrendingDown, Plus, ArrowLeftRight, XCircle, MessageSquareMore, Zap } from 'lucide-react';
import { TableRow, TableCell } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { formatCurrency, formatDate } from '@/lib/format';
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

const STRATEGY_LABEL: Record<string, string> = {
  CDS: 'Call Debit Spread',
  PDS: 'Put Debit Spread',
  CCS: 'Call Credit Spread',
  PCS: 'Put Credit Spread',
  CALL: 'Call',
  PUT: 'Put',
  STOCK: 'Stock',
};

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

  // Slippage tooltip (flag-based — from fill enrichment)
  const brokerFill = trade.brokerFillPrice != null ? safeParseFloat(trade.brokerFillPrice) : null;
  const oldSlippage = entry && brokerFill ? brokerFill - entry : null;
  const oldSlippagePct = entry && oldSlippage ? Math.abs(oldSlippage / entry) : null;
  const slippageTooltip = oldSlippage != null
    ? `Slippage: ${oldSlippage > 0 ? '+' : ''}${formatCurrency(oldSlippage)} (${(oldSlippagePct! * 100).toFixed(1)}%) — entry est. ${formatCurrency(entry)} vs fill ${formatCurrency(brokerFill)}`
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
      className={`hover:bg-accent/40 transition-colors ${onExpand ? 'cursor-pointer' : ''} ${isExpanded ? 'bg-accent/20' : ''} ${rowBorder}`}
      onClick={onExpand}
    >
      {/* Expand chevron */}
      <TableCell className="w-6 pr-0">
        {onExpand ? (
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground/40 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
        ) : null}
      </TableCell>

      {/* Trade: symbol + direction + contract + flags — all inline */}
      <TableCell>
        <span className="inline-flex items-center gap-1.5">
          {/* Direction arrow */}
          {trade.direction === 'LONG' ? (
            <ArrowUp className="h-3 w-3 text-muted-foreground/40 shrink-0" />
          ) : (
            <ArrowDown className="h-3 w-3 text-muted-foreground/40 shrink-0" />
          )}

          <Link
            to={href(`/trades/${trade.id}`)}
            className="text-foreground font-medium text-sm hover:underline underline-offset-2 decoration-muted-foreground/30"
            onClick={(e) => e.stopPropagation()}
          >
            {trade.symbol}
          </Link>

          {/* Legs summary inline — "145P 3/15" or "190/195PDS 10/24" */}
          {legsSummary && (
            <span className="text-[11px] text-muted-foreground/50 tabular-nums">{legsSummary}</span>
          )}

          {/* Strategy label — only for single-leg options without legs data */}
          {isOption && !legsSummary && (
            <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">
              {trade.strategy}
            </span>
          )}

          {/* Flag icons */}
          {activeFlags.length > 0 && (
            <span className="inline-flex items-center gap-0.5 ml-0.5">
              {activeFlags.map((f) => (
                <FlagIcon key={f} flag={f} tooltip={f === 'slippage' ? slippageTooltip : undefined} />
              ))}
            </span>
          )}

          {/* Chase icon + slippage */}
          {(chaseSteps > 0 || hasSlippage) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={`inline-flex items-center gap-0.5 transition-colors ${SEVERITY_COLOR[hasSlippage && totalSlippage > 0 ? (chaseSeverity === 'muted' ? 'warn' : chaseSeverity) : chaseSeverity]}`}>
                  <Zap className="h-3 w-3" />
                  {hasSlippage && totalSlippage !== 0 && (
                    <span className="text-[10px] tabular-nums">{formatCurrency(totalSlippage)}</span>
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs space-y-0.5">
                {chaseSteps > 0 && (
                  <div>{chaseSteps} chase step{chaseSteps > 1 ? 's' : ''}</div>
                )}
                {entrySlippage != null && (
                  <div>Entry slippage: {entrySlippage > 0 ? '+' : ''}{formatCurrency(entrySlippage)}</div>
                )}
                {exitSlippage != null && (
                  <div>Exit slippage: {exitSlippage > 0 ? '+' : ''}{formatCurrency(exitSlippage)}</div>
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
    </TableRow>
  );
}
