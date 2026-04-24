import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronRight,
  CircleCheck,
  MessageSquareMore,
  Plus,
  Scissors,
  Timer,
  TrendingDown,
  XCircle,
  Zap,
} from 'lucide-react';
import { createFilterParams } from '@/hooks/use-filter-params';
import { useSearchParam } from '@/hooks/use-search-param';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { DataTable } from '@/components/data-table';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useTradesView } from './trades-view-context';
import { TradeDetailPanel } from '@/views/trades/[id]/trade-detail-panel';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { safeParseFloat } from '@src/lib/numbers';
import { computeTradeCommission } from '@src/lib/commission';
import { contractMultiplier, formatLegsSummary, tradeQty } from '@src/lib/trade';
import { getEventMeta, getTradeMeta } from '@/lib/snapshot-accessors';
import type { Column } from '@/lib/api-types';
import type { CommissionSchedule, Trade, TradeEvent, TradeFlag } from '@src/db/schema';
import type { TradeLabel } from '@src/local-api/http-schemas';
import type { LivePosition } from '@/lib/trade-story';
import type { LucideIcon } from 'lucide-react';

type SortColumn = 'pnl' | 'openedAt';

const EMPTY_EVENTS: readonly TradeEvent[] = [];
const EMPTY_FLAGS: readonly TradeFlag[] = [];

const FLAG_ICONS: Record<string, { icon: LucideIcon; tooltip: string; severity: 'muted' | 'warn' | 'danger' }> = {
  autoClose: { icon: Timer, tooltip: 'Auto-closed - no exit signal from trader', severity: 'warn' },
  legOff: { icon: Scissors, tooltip: 'Had a leg removed - spread became single-leg', severity: 'warn' },
  trim: { icon: TrendingDown, tooltip: 'Position was partially exited', severity: 'muted' },
  add: { icon: Plus, tooltip: 'Position was scaled into', severity: 'muted' },
  slippage: { icon: ArrowLeftRight, tooltip: 'Significant slippage detected', severity: 'warn' },
  closeFailed: { icon: XCircle, tooltip: 'A close order was cancelled without filling', severity: 'danger' },
  marketDataFail: { icon: XCircle, tooltip: 'Market data fetch failed for this trade', severity: 'danger' },
  hasUpdate: { icon: MessageSquareMore, tooltip: 'Trader posted about this symbol after opening', severity: 'muted' },
};

const SEVERITY_COLOR = {
  muted: 'text-muted-foreground/50 hover:text-muted-foreground',
  warn: 'text-warning/60 hover:text-warning',
  danger: 'text-destructive/60 hover:text-destructive',
};

const STACKED_DETAIL_MAX_WIDTH = 639;

const useTradeSortParams = createFilterParams({
  sort: { type: 'sort', defaultColumn: 'openedAt', defaultDir: 'desc' },
});

type TradePresentation = {
  activeFlags: TradeFlag[];
  chaseSteps: number;
  hasSlippage: boolean;
  isOption: boolean;
  legsSummary: string | null;
  markPrice: number | null;
  pnl: number | null;
  pnlIsLive: boolean;
  pnlPct: number | null;
  rowBorder: string;
  slippageEmphasis: number;
  slippageIntensity: number;
  slippagePct: number | null;
  slippageTitle: string;
  subLabel: string;
  totalSlippage: number;
};

type TradeTableRow = {
  kind: 'trade';
  key: string;
  trade: Trade;
  events: readonly TradeEvent[];
  flags: readonly TradeFlag[];
  label?: TradeLabel;
  livePosition?: LivePosition;
  presentation: TradePresentation;
  isSelected: boolean;
};

type EventTableRow = {
  kind: 'event';
  key: string;
  event: TradeEvent;
  tradeId: string;
  closeMessageId?: string | null;
};

type TableRow = TradeTableRow | EventTableRow;

export function TradesTableClient({
  trades,
}: {
  trades: Trade[];
}) {
  const {
    eventsByTradeId,
    flagsByTradeId,
    labelsByTradeId,
    livePositionsByTradeId,
    commissionSchedule,
  } = useTradesView();
  const [urlTradeId, setUrlTradeId] = useSearchParam('trade');
  const sortParams = useTradeSortParams();
  const sortColumn = sortParams.sort.column as SortColumn;
  const sortDirection = sortParams.sort.dir;
  const setSort = sortParams.setSort;
  const hasLabels = Object.keys(labelsByTradeId).length > 0;
  const isStackedLayout = useIsStackedTradeLayout();

  const unrealizedPnl = useMemo(() => {
    const map: Record<string, number> = {};
    for (const [id, position] of Object.entries(livePositionsByTradeId)) {
      map[id] = position.unrealizedPnl;
    }
    return map;
  }, [livePositionsByTradeId]);

  const setSelectedId = useCallback((id: string | null) => {
    setUrlTradeId(id);
  }, [setUrlTradeId]);

  const sortedTrades = useMemo(() => {
    const rows = [...trades];
    if (sortColumn === 'pnl') {
      rows.sort((a, b) => {
        const aPnl = getEffectivePnl(a, unrealizedPnl, commissionSchedule);
        const bPnl = getEffectivePnl(b, unrealizedPnl, commissionSchedule);
        if (aPnl == null && bPnl == null) return 0;
        if (aPnl == null) return 1;
        if (bPnl == null) return -1;
        return sortDirection === 'desc' ? bPnl - aPnl : aPnl - bPnl;
      });
    } else {
      rows.sort((a, b) => {
        const aDate = a.openedAt ?? '';
        const bDate = b.openedAt ?? '';
        return sortDirection === 'desc'
          ? bDate.localeCompare(aDate)
          : aDate.localeCompare(bDate);
      });
    }
    return rows;
  }, [commissionSchedule, sortColumn, sortDirection, trades, unrealizedPnl]);

  const selectedTrade = urlTradeId
    ? trades.find((trade) => trade.id === urlTradeId) ?? null
    : null;

  const rows = useMemo<TableRow[]>(() => {
    const nextRows: TableRow[] = [];
    for (const trade of sortedTrades) {
      const events = eventsByTradeId[trade.id] ?? EMPTY_EVENTS;
      const flags = flagsByTradeId[trade.id] ?? EMPTY_FLAGS;
      const livePosition = livePositionsByTradeId[trade.id];
      nextRows.push({
        kind: 'trade',
        key: `trade:${trade.id}`,
        trade,
        events,
        flags,
        label: labelsByTradeId[trade.id],
        livePosition,
        presentation: buildTradePresentation(trade, events, flags, livePosition, commissionSchedule),
        isSelected: urlTradeId === trade.id,
      });

      for (const event of events) {
        nextRows.push({
          kind: 'event',
          key: `event:${event.id}`,
          event,
          tradeId: trade.id,
          closeMessageId: trade.closeMessageId,
        });
      }
    }
    return nextRows;
  }, [commissionSchedule, eventsByTradeId, flagsByTradeId, labelsByTradeId, livePositionsByTradeId, sortedTrades, urlTradeId]);

  const columns = useMemo((): Column<TableRow>[] => {
    const base: Column<TableRow>[] = [
      {
        key: 'chevron',
        label: '',
        className: 'w-5 px-1',
        render: (row) => (row.kind === 'trade'
          ? (
            <ChevronRight
              className={`h-3.5 w-3.5 text-muted-foreground/40 transition-transform duration-200 ${row.isSelected ? 'rotate-90' : ''}`}
            />
          )
          : null),
      },
      {
        key: 'position',
        label: 'Position',
        sortable: true,
        className: hasLabels ? 'w-[52%]' : 'w-[62%]',
        render: (row) => (row.kind === 'trade'
          ? <TradeIdentityCell row={row} />
          : <EventIdentityCell row={row} />),
      },
      {
        key: 'pnl',
        label: 'Mark / P&L',
        sortable: true,
        align: 'right',
        className: hasLabels ? 'w-[34%]' : 'w-[38%]',
        render: (row) => (row.kind === 'trade'
          ? <TradePnlCell row={row} />
          : <EventPnlCell row={row} />),
      },
    ];

    if (hasLabels) {
      base.push({
        key: 'label',
        label: 'Label',
        className: 'w-11 min-w-11 max-w-11 px-1 text-center',
        render: (row) => (row.kind === 'trade'
          ? <TradeLabelCell label={row.label} />
          : null),
      });
    }

    return base;
  }, [hasLabels]);

  if (trades.length === 0) {
    return <EmptyState title="No trades" />;
  }

  if (isStackedLayout) {
    return (
      <Card className="py-0 gap-0 flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {selectedTrade ? (
          <div className="h-full overflow-auto overscroll-none">
            <TradeDetailPanel
              trade={selectedTrade}
              showLabelSection={hasLabels}
              onClose={() => setSelectedId(null)}
            />
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            sort={sortParams.sort}
            onSortChange={setSort}
            onRowClick={(row) => {
              if (row.kind === 'trade') {
                setSelectedId(row.trade.id);
              }
            }}
            rowClassName={(row) => row.kind === 'trade'
              ? `h-[60px] ${row.isSelected ? 'bg-background' : ''} ${row.presentation.rowBorder} cursor-pointer`
              : 'bg-muted/30 hover:bg-muted/50 h-7'}
            className="h-full rounded-none border-0"
            getRowKey={(row) => row.key}
          />
        )}
      </Card>
    );
  }

  return (
    <Card className="py-0 gap-0 flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        <ResizablePanel defaultSize={62} minSize={40} className="min-h-0 overflow-hidden">
          <div className="h-full overflow-hidden">
            <DataTable
              columns={columns}
              data={rows}
              sort={sortParams.sort}
              onSortChange={setSort}
              onRowClick={(row) => {
                if (row.kind === 'trade') {
                  setSelectedId(row.trade.id);
                }
              }}
              rowClassName={(row) => row.kind === 'trade'
                ? `h-[60px] ${row.isSelected ? 'bg-background' : ''} ${row.presentation.rowBorder} cursor-pointer`
                : 'bg-muted/30 hover:bg-muted/50 h-7'}
              className="h-full rounded-none border-0"
              getRowKey={(row) => row.key}
            />
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={38} minSize={30} className="min-h-0 overflow-hidden">
          <div className="h-full overflow-auto overscroll-none">
            {selectedTrade ? (
              <TradeDetailPanel
                trade={selectedTrade}
                showLabelSection={hasLabels}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              <EmptyState title="Select a trade" hint="Click a row to view details" />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Card>
  );
}

function useIsStackedTradeLayout() {
  const [isStacked, setIsStacked] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(`(max-width: ${STACKED_DETAIL_MAX_WIDTH}px)`);
    const update = () => setIsStacked(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);

  return isStacked;
}

function getEffectivePnl(
  trade: Trade,
  unrealizedPnl: Record<string, number>,
  commissionSchedule: Parameters<typeof computeTradeCommission>[1] | undefined,
): number | null {
  if (trade.pnl != null) {
    const gross = safeParseFloat(trade.pnl);
    const comm = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
    return gross - comm;
  }
  if (trade.status === 'OPEN' && trade.id in unrealizedPnl) {
    return unrealizedPnl[trade.id];
  }
  return null;
}

function buildTradePresentation(
  trade: Trade,
  events: readonly TradeEvent[],
  flags: readonly TradeFlag[],
  livePosition: LivePosition | undefined,
  commissionSchedule: CommissionSchedule | undefined,
): TradePresentation {
  const grossPnl = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
  const comm = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
  const realizedPnl = grossPnl != null ? grossPnl - comm : null;
  const isOpen = trade.status === 'OPEN';
  const pnl = realizedPnl ?? (isOpen && livePosition ? livePosition.unrealizedPnl : null);
  const pnlIsLive = realizedPnl == null && pnl != null;
  const entry = trade.entryPrice != null ? safeParseFloat(trade.entryPrice) : null;
  const pnlPct = pnl != null && entry != null && entry !== 0 && trade.quantity
    ? (pnl / (entry * trade.quantity)) * 100
    : null;

  const qty = tradeQty(trade.quantity);
  const mult = contractMultiplier(trade.strategy);
  const markPrice = isOpen && livePosition?.marketValue != null && qty > 0
    ? livePosition.marketValue / (qty * mult)
    : null;

  const rowBorder = pnl != null && pnl !== 0
    ? pnl > 0 ? 'border-l-2 border-l-profit/60' : 'border-l-2 border-l-loss/60'
    : '';

  const openEvent = events.find((event) => event.action === 'OPEN');
  const openLegs = openEvent ? openEvent.legs : trade.legs;
  const openStrategy = openEvent?.strategy ?? trade.strategy;
  const legsSummary = formatLegsSummary(openLegs, openStrategy);
  const isOption = trade.strategy !== 'STOCK';

  const meta = getTradeMeta(trade);
  const entrySlippage = meta.entrySlippage ?? null;
  const exitSlippage = meta.exitSlippage ?? null;
  const totalSlippage = (entrySlippage ?? 0) + (exitSlippage ?? 0);
  const hasSlippage = entrySlippage != null || exitSlippage != null;
  const slippagePct = entry && totalSlippage !== 0 ? Math.abs(totalSlippage / entry) * 100 : null;
  const slippageIntensity = slippagePct != null ? Math.min(slippagePct / 5, 1) : 0;
  const slippageEmphasis = slippagePct != null ? Math.min(Math.max((slippagePct - 5) / 10, 0), 1) : 0;

  const chaseSteps = events.reduce((sum, event) => {
    const steps = getEventMeta(event).chaseSteps;
    return sum + (typeof steps === 'number' ? steps : 0);
  }, 0);

  const activeFlags = flags.filter((flag) => flag !== 'chaseWarn' && flag !== 'chaseDanger' && FLAG_ICONS[flag]);
  const subLabel = trade.strategy === 'STOCK'
    ? `${qty} sh · ${trade.direction}`
    : `${qty}x ${trade.strategy} · ${trade.direction}`;

  const slippageTitle = [
    chaseSteps > 0 ? `${chaseSteps} chase step${chaseSteps > 1 ? 's' : ''}` : null,
    entrySlippage != null ? `Entry slippage: ${formatCurrency(Math.abs(entrySlippage))}` : null,
    exitSlippage != null ? `Exit slippage: ${formatCurrency(Math.abs(exitSlippage))}` : null,
  ].filter(Boolean).join('\n');

  return {
    activeFlags,
    chaseSteps,
    hasSlippage,
    isOption,
    legsSummary,
    markPrice,
    pnl,
    pnlIsLive,
    pnlPct,
    rowBorder,
    slippageEmphasis,
    slippageIntensity,
    slippagePct,
    slippageTitle,
    subLabel,
    totalSlippage,
  };
}

function TradeIdentityCell({ row }: { row: TradeTableRow }) {
  const href = useScopedHref();
  const { pathname } = useLocation();
  const { trade, presentation } = row;

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <Link
          to={href(`/trades/${trade.id}`, { from: pathname })}
          className="text-foreground font-semibold text-sm tracking-tight hover:underline underline-offset-2 decoration-muted-foreground/30 truncate"
          onClick={(event) => event.stopPropagation()}
        >
          {trade.symbol}
          {presentation.legsSummary ? ` ${presentation.legsSummary}` : presentation.isOption ? ` ${trade.strategy}` : ''}
        </Link>

        {presentation.activeFlags.length > 0 && (
          <span className="inline-flex items-center gap-1 shrink-0">
            {presentation.activeFlags.map((flag) => (
              <FlagIcon key={flag} flag={flag} />
            ))}
          </span>
        )}

        {(presentation.chaseSteps > 0 || presentation.hasSlippage) && (
          <span
            className={`inline-flex items-center gap-0.5 shrink-0 transition-colors ${presentation.slippageEmphasis > 0 ? 'rounded-sm px-1' : ''}`}
            title={presentation.slippageTitle}
            aria-label={presentation.slippageTitle}
            style={presentation.hasSlippage && presentation.slippageIntensity > 0
              ? {
                  color: `color-mix(in oklab, var(--destructive) ${Math.round(presentation.slippageIntensity * 100)}%, var(--muted-foreground))`,
                  ...(presentation.slippageEmphasis > 0 ? {
                    fontWeight: Math.round(400 + presentation.slippageEmphasis * 500),
                    backgroundColor: `color-mix(in oklab, var(--destructive) ${Math.round(presentation.slippageEmphasis * 25)}%, transparent)`,
                    boxShadow: `0 0 ${Math.round(presentation.slippageEmphasis * 16)}px color-mix(in oklab, var(--destructive) ${Math.round(presentation.slippageEmphasis * 50)}%, transparent), 0 0 ${Math.round(presentation.slippageEmphasis * 40)}px color-mix(in oklab, var(--destructive) ${Math.round(presentation.slippageEmphasis * 20)}%, transparent)`,
                    textShadow: `0 0 ${Math.round(presentation.slippageEmphasis * 10)}px color-mix(in oklab, var(--destructive) ${Math.round(presentation.slippageEmphasis * 90)}%, transparent), 0 0 ${Math.round(presentation.slippageEmphasis * 30)}px color-mix(in oklab, var(--destructive) ${Math.round(presentation.slippageEmphasis * 50)}%, transparent)`,
                    outline: presentation.slippageEmphasis > 0.3
                      ? `1px solid color-mix(in oklab, var(--destructive) ${Math.round(presentation.slippageEmphasis * 50)}%, transparent)`
                      : undefined,
                  } : {}),
                }
              : undefined}
          >
            <Zap className="h-3 w-3" />
            {presentation.hasSlippage && presentation.totalSlippage !== 0 && (
              <span className="text-[10px] tabular-nums">
                {formatCurrency(Math.abs(presentation.totalSlippage))}
                {presentation.slippagePct != null && (
                  <span className="ml-0.5">({presentation.slippagePct.toFixed(1)}%)</span>
                )}
              </span>
            )}
          </span>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground/70 tabular-nums truncate mt-0.5">
        {presentation.subLabel} · {formatDate(trade.openedAt)}
      </p>
    </div>
  );
}

function TradePnlCell({ row }: { row: TradeTableRow }) {
  const { presentation, trade } = row;
  const pnlTitle = presentation.pnlIsLive
    ? 'Unrealized P&L (live broker quote)'
    : 'Realized P&L (net of commission)';

  return (
    <div>
      <div className="font-mono tabular-nums text-sm">
        {presentation.markPrice != null
          ? <span className="text-foreground">{formatCurrency(presentation.markPrice)}</span>
          : trade.exitPrice != null
            ? <span className="text-muted-foreground">{formatCurrency(trade.exitPrice)}</span>
            : <span className="text-muted-foreground/40">--</span>}
      </div>
      {presentation.pnl != null ? (
        <div className="inline-flex items-center gap-1 justify-end mt-0.5 whitespace-nowrap" title={pnlTitle} aria-label={pnlTitle}>
          {presentation.pnlIsLive && (
            <span className="h-1.5 w-1.5 rounded-full bg-info animate-pulse" aria-hidden />
          )}
          <span className={`font-mono text-[11px] font-medium tabular-nums ${pnlColor(presentation.pnl)}`}>
            {formatCurrency(presentation.pnl)}
          </span>
          {presentation.pnlPct != null && (
            <span className={`font-mono text-[10px] tabular-nums ${pnlColor(presentation.pnl)} opacity-70`}>
              ({presentation.pnlPct > 0 ? '+' : ''}{presentation.pnlPct.toFixed(1)}%)
            </span>
          )}
        </div>
      ) : (
        <div className="text-muted-foreground/40 font-mono text-[10px] mt-0.5">--</div>
      )}
    </div>
  );
}

function TradeLabelCell({ label }: { label: TradeLabel | undefined }) {
  if (!label || label.bucket === 'unlabeled') {
    return (
      <span title="No label" className="flex w-full justify-center">
        <AlertTriangle className="h-3.5 w-3.5 text-warning" />
      </span>
    );
  }

  if (label.bucket === 'fp') {
    return (
      <span title="Label says not a trade" className="flex w-full justify-center">
        <XCircle className="h-3.5 w-3.5 text-destructive" />
      </span>
    );
  }

  const mismatches = label.match?.mismatches ?? [];
  if (mismatches.length === 0) {
    return (
      <span title="Label match" className="flex w-full justify-center">
        <CircleCheck className="h-3.5 w-3.5 text-profit" />
      </span>
    );
  }

  return (
    <span className="relative flex w-full justify-center" title={`Trade matched, ${mismatches.length} field diff${mismatches.length !== 1 ? 's' : ''}`}>
      <CircleCheck className="h-3.5 w-3.5 text-profit" />
      <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-warning" />
    </span>
  );
}

function EventIdentityCell({ row }: { row: EventTableRow }) {
  const { event, closeMessageId } = row;
  const targetStrategy = event.action === 'LEG_OFF'
    ? (event.metadata?.targetStrategy as string | undefined)
    : undefined;
  const qtyPrefix = event.action === 'ADD' ? '+' : event.action === 'TRIM' ? '-' : '';

  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground/30 text-[10px]">&middot;</span>
      <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
        {event.action}
      </span>
      <span className="text-[11px] tabular-nums text-muted-foreground/60">
        {qtyPrefix}{event.quantity}
      </span>
      {event.action === 'CLOSE' && (
        <span className="text-[10px] text-muted-foreground/40 italic">
          {closeMessageId ? 'signal' : 'auto'}
        </span>
      )}
      {targetStrategy && (
        <span className="text-[10px] text-muted-foreground/50">
          {'->'} {targetStrategy}
        </span>
      )}
      <span className="text-[10px] text-muted-foreground/40 ml-auto">
        {formatDate(event.timestamp)}
      </span>
    </span>
  );
}

function EventPnlCell({ row }: { row: EventTableRow }) {
  const price = safeParseFloat(row.event.price);
  const meta = row.event.metadata as Record<string, unknown> | null;
  const trimPnl = row.event.action === 'TRIM' ? (meta?.trimPnl as number | undefined) : undefined;

  return (
    <div>
      <div className="font-mono tabular-nums text-xs text-muted-foreground/70">
        {formatCurrency(price)}
      </div>
      {trimPnl != null && (
        <div className={`font-mono tabular-nums text-[10px] ${pnlColor(trimPnl)}`}>
          {formatCurrency(trimPnl)}
        </div>
      )}
    </div>
  );
}

function FlagIcon({ flag }: { flag: string }) {
  const def = FLAG_ICONS[flag];
  if (!def) return null;
  const Icon = def.icon;
  return (
    <span className="inline-flex" title={def.tooltip} aria-label={def.tooltip}>
      <Icon className={`h-3 w-3 transition-colors ${SEVERITY_COLOR[def.severity]}`} />
    </span>
  );
}
