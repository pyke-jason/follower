'use client';

import Link from 'next/link';
import { ChevronRight, Timer, Scissors, TrendingDown, Plus, ArrowLeftRight, XCircle, MessageSquareMore } from 'lucide-react';
import { Badge } from './badge';
import { LegsIndicator } from './legs-indicator';
import { TableRow, TableCell } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import { getLegs } from '@src/db/accessors';
import { safeParseFloat } from '@src/lib/numbers';
import { computeTradeCommission } from '@src/lib/commission';
import { notionalValue } from '@src/lib/trade';
import { useTradesStore } from '@/stores/trades-store';
import type { LucideIcon } from 'lucide-react';

function notionalConcentrationColor(pct: number): string {
  if (pct >= 0.25) return 'text-loss';
  if (pct >= 0.15) return 'text-amber-500';
  return 'text-muted-foreground';
}

/** Slippage is significant if > 10% of entry price or > $0.20 absolute. */
const SLIPPAGE_THRESHOLD_PCT = 0.10;
const SLIPPAGE_THRESHOLD_ABS = 0.20;

type FlagDef = {
  icon: LucideIcon;
  label: string;
  tooltip: string;
  color: string;
  bgColor: string;
};

const FLAG_DEFS = {
  autoClose: {
    icon: Timer,
    label: 'Auto',
    tooltip: 'Auto-closed — no exit signal from trader',
    color: 'text-amber-300',
    bgColor: 'bg-amber-400/15 border border-amber-400/25',
  },
  legOff: {
    icon: Scissors,
    label: 'Leg off',
    tooltip: 'Had a leg removed — spread became single-leg',
    color: 'text-amber-300',
    bgColor: 'bg-amber-400/15 border border-amber-400/25',
  },
  trim: {
    icon: TrendingDown,
    label: 'Trimmed',
    tooltip: 'Position was partially exited',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted/50 border border-border/40',
  },
  add: {
    icon: Plus,
    label: 'Added',
    tooltip: 'Position was scaled into',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted/50 border border-border/40',
  },
  slippage: {
    icon: ArrowLeftRight,
    label: 'Slip',
    tooltip: '', // filled dynamically
    color: 'text-amber-300',
    bgColor: 'bg-amber-400/15 border border-amber-400/25',
  },
  closeCancelled: {
    icon: XCircle,
    label: 'Close failed',
    tooltip: 'A close order was cancelled without filling — trade stayed open longer than intended',
    color: 'text-rose-400',
    bgColor: 'bg-rose-400/15 border border-rose-400/25',
  },
  hasUpdate: {
    icon: MessageSquareMore,
    label: 'Update',
    tooltip: 'Trader posted about this symbol after opening',
    color: 'text-amber-300',
    bgColor: 'bg-amber-400/15 border border-amber-400/25',
  },
} as const satisfies Record<string, FlagDef>;

function FlagChip({ flag, tooltip }: { flag: FlagDef; tooltip?: string }) {
  const Icon = flag.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-flex items-center gap-0.5 rounded-sm px-1 py-px text-[9px] font-medium leading-tight ${flag.color} ${flag.bgColor}`}>
          <Icon className="h-2.5 w-2.5" />
          {flag.label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-60 text-xs">
        {tooltip ?? flag.tooltip}
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
  const trade = useTradesStore((s) => s.trades.find((t) => t.id === tradeId))!;
  const events = useTradesStore((s) => s.eventsByTradeId.get(tradeId)) ?? [];
  const cancelledClose = useTradesStore((s) => s.cancelledTradeIds.has(tradeId));
  const hasUpdate = useTradesStore((s) => s.subsequentMessageTradeIds.has(tradeId));
  const runId = useTradesStore((s) => s.runId);
  const commissionSchedule = useTradesStore((s) => s.commissionSchedule);
  const startingEquity = useTradesStore((s) => s.startingEquity);
  const grossPnl = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
  const comm = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
  const pnl = grossPnl != null ? grossPnl - comm : null;
  const pnlBorder = pnl != null && pnl !== 0
    ? pnl > 0 ? 'border-l-2 border-l-profit/70' : 'border-l-2 border-l-loss/70'
    : '';

  const realizedPnl = trade.realizedPnl != null ? safeParseFloat(trade.realizedPnl) : null;
  const notional = notionalValue(trade.entryPrice, trade.quantity, trade.strategy);
  const notionalPct = notional > 0 && startingEquity != null && startingEquity > 0
    ? notional / startingEquity
    : null;

  // Compute flags
  const actions = new Set(events?.map((e) => e.action));
  const isAutoClose = trade.status === 'CLOSED' && !trade.closeMessageId;
  const hasLegOff = actions.has('LEG_OFF');
  const hasTrim = actions.has('TRIM');
  const hasAdd = actions.has('ADD');

  const entry = trade.entryPrice != null ? safeParseFloat(trade.entryPrice) : null;
  const brokerFill = trade.brokerFillPrice != null ? safeParseFloat(trade.brokerFillPrice) : null;
  const slippage = entry && brokerFill ? brokerFill - entry : null;
  const slippagePct = entry && slippage ? Math.abs(slippage / entry) : null;
  const hasSignificantSlippage = slippage != null && (
    (slippagePct != null && slippagePct >= SLIPPAGE_THRESHOLD_PCT) ||
    Math.abs(slippage) >= SLIPPAGE_THRESHOLD_ABS
  );

  const hasFlags = isAutoClose || hasLegOff || hasTrim || hasAdd || hasSignificantSlippage || cancelledClose || hasUpdate;

  return (
    <TableRow
      className={`hover:bg-accent/40 transition-colors ${onExpand ? 'cursor-pointer' : ''} ${isExpanded ? 'bg-accent/20' : ''}`}
      onClick={onExpand}
    >
      {/* Expand chevron */}
      <TableCell className="w-6">
        {onExpand ? (
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
        ) : null}
      </TableCell>

      {/* Symbol */}
      <TableCell>
        <Link
          href={buildHref(`/trades/${trade.id}`, runId ?? undefined)}
          className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40"
          onClick={(e) => e.stopPropagation()}
        >
          {trade.symbol}
        </Link>
      </TableCell>

      {/* Status + flags */}
      <TableCell>
        <span className="inline-flex items-center gap-1 flex-wrap">
          <Badge label={trade.status} />
          {cancelledClose && <FlagChip flag={FLAG_DEFS.closeCancelled} />}
          {isAutoClose && <FlagChip flag={FLAG_DEFS.autoClose} />}
          {hasLegOff && <FlagChip flag={FLAG_DEFS.legOff} />}
          {hasTrim && <FlagChip flag={FLAG_DEFS.trim} />}
          {hasAdd && <FlagChip flag={FLAG_DEFS.add} />}
          {hasSignificantSlippage && (
            <FlagChip
              flag={FLAG_DEFS.slippage}
              tooltip={`Slippage: ${slippage! > 0 ? '+' : ''}${formatCurrency(slippage)} (${(slippagePct! * 100).toFixed(1)}%) — entry est. ${formatCurrency(entry)} vs fill ${formatCurrency(brokerFill)}`}
            />
          )}
          {hasUpdate && <FlagChip flag={FLAG_DEFS.hasUpdate} />}
        </span>
      </TableCell>

      {/* Legs */}
      <TableCell className="hidden md:table-cell text-muted-foreground">
        <LegsIndicator legs={getLegs(trade)} strategy={trade.strategy} />
      </TableCell>

      {/* Trader */}
      <TableCell>
        <Link
          href={`/traders/${encodeURIComponent(trade.trader)}`}
          className="text-muted-foreground text-xs hover:text-foreground hover:underline underline-offset-2 decoration-muted-foreground/40 transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          {trade.trader}
        </Link>
      </TableCell>

      {/* Direction */}
      <TableCell>
        <Badge label={trade.direction} />
      </TableCell>

      {/* Strategy */}
      <TableCell>
        <Badge label={trade.strategy} />
      </TableCell>

      {/* Qty */}
      <TableCell className="hidden lg:table-cell text-right tabular-nums text-xs">
        {trade.quantity ?? 1}
      </TableCell>

      {/* Entry */}
      <TableCell className="text-right tabular-nums text-xs">{formatCurrency(trade.entryPrice)}</TableCell>

      {/* Exit */}
      <TableCell className="text-right tabular-nums text-xs">{formatCurrency(trade.exitPrice)}</TableCell>

      {/* Notional */}
      <TableCell className="hidden lg:table-cell text-right tabular-nums text-xs">
        {notional > 0 ? (
          <span className="text-muted-foreground whitespace-nowrap">
            {formatCurrency(notional)}
            {notionalPct != null && (
              <span className={`text-[10px] ml-1 ${notionalConcentrationColor(notionalPct)}`}>
                {(notionalPct * 100).toFixed(1)}%
              </span>
            )}
          </span>
        ) : '--'}
      </TableCell>

      {/* P&L */}
      <TableCell className={`text-right tabular-nums font-medium ${pnl != null && pnl >= 0 ? 'text-profit' : pnl != null && pnl < 0 ? 'text-loss' : ''} ${pnlBorder}`}>
        {formatCurrency(pnl)}
        {comm > 0 && <span className="text-muted-foreground font-normal text-[10px] ml-0.5">({formatCurrency(-comm)})</span>}
      </TableCell>

      {/* Realized P&L */}
      <TableCell className={`hidden lg:table-cell text-right tabular-nums text-xs ${realizedPnl != null && realizedPnl !== 0 ? pnlColor(realizedPnl) : ''}`}>
        {realizedPnl != null && realizedPnl !== 0 ? formatCurrency(realizedPnl) : '--'}
      </TableCell>

      {/* Opened */}
      <TableCell className="text-muted-foreground text-xs">
        {formatDate(trade.openedAt)}
      </TableCell>
    </TableRow>
  );
}
