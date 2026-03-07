import { Badge } from './badge';
import { StatItem } from './stat-item';
import { cn } from '@/lib/utils';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { safeParseFloat } from '@src/lib/numbers';
import { formatLegsSummary } from '@src/lib/trade';
import type { RunDecision, TradeEvent, Message } from '@src/db/schema';
import { useTradesStore } from '@/stores/trades-store';
import {
  ParseResultView, SignalView, SizedView, OrderPlacedView, OrderFilledView,
  OrderCancelledView, SettledView, ErrorView, FallbackJson,
} from './snapshot-detail';
import { fmtMs, EVENT_LABEL, DOT, getInlineSummary, REACTION_EMOJI } from './decision-shared';

const ACTION_LABEL: Record<string, string> = {
  OPEN: 'Opened', CLOSE: 'Closed', TRIM: 'Trimmed', ADD: 'Added', LEG_OFF: 'Leg Off',
};

const PATH_LABEL: Record<string, string> = {
  orchestrator: 'Agent', deterministic: 'Deterministic',
  skipped: 'Hard Skip', pipeline_failure: 'Pipeline Fail',
};

// ─── Redundant SETTLED filter ───────────────────────

/** Keep every non-SETTLED row. For SETTLED: hide orchestrator rows that duplicate per-signal rows. */
function filterRedundantSettled(decisions: RunDecision[]): RunDecision[] {
  const settledByMsg = new Map<string, RunDecision[]>();

  for (const d of decisions) {
    if ((d.event ?? 'SETTLED') !== 'SETTLED') continue;
    if (!d.messageId) continue;
    const list = settledByMsg.get(d.messageId) ?? [];
    list.push(d);
    settledByMsg.set(d.messageId, list);
  }

  const hideIds = new Set<string>();

  for (const rows of settledByMsg.values()) {
    const perSignal = rows.filter(r => r.signalIndex != null);
    const orchestrator = rows.filter(r => r.phase === 'orchestrator');
    if (perSignal.length === 0 || orchestrator.length === 0) continue;

    for (const orch of orchestrator) {
      if (perSignal.some(ps => ps.outcome === orch.outcome)) {
        hideIds.add(orch.id);
      }
    }
  }

  return decisions.filter(d => !hideIds.has(d.id));
}

// ─── Snapshot Dispatch ───────────────────────────────

export function SnapshotDispatch({ event, snapshot, reasoning }: { event: string; snapshot: Record<string, unknown>; reasoning?: string | null }) {
  switch (event) {
    case 'PARSED':
      return <ParseResultView data={snapshot} />;
    case 'SIGNAL_RESOLVED':
      return <SignalView data={snapshot} />;
    case 'SIZED':
      return <SizedView data={snapshot} />;
    case 'ORDER_PLACED':
      return <OrderPlacedView data={snapshot} />;
    case 'ORDER_FILLED':
      return <OrderFilledView data={snapshot} />;
    case 'ORDER_CANCELLED':
      return <OrderCancelledView data={snapshot} />;
    case 'ORDER_ADJUSTED': {
      const params = (snapshot.pending as Record<string, unknown>)?.params as Record<string, unknown> | undefined ??
                     (snapshot.params as Record<string, unknown> | undefined);
      const rules = Array.isArray(params?.adjustmentRules) ? params.adjustmentRules as Record<string, unknown>[] : [];
      const rule = rules[0];
      const initialLimit = params?.limitPrice != null ? Number(params.limitPrice) : null;
      const chaseLimit = rule?.chaseLimit != null ? Number(rule.chaseLimit) : null;
      const stepAmount = rule?.stepAmount != null ? Number(rule.stepAmount) : null;
      const maxSteps = initialLimit != null && chaseLimit != null && stepAmount != null && stepAmount > 0
        ? Math.floor(Math.abs(initialLimit - chaseLimit) / stepAmount)
        : null;
      const step = snapshot.step != null ? Number(snapshot.step) : null;

      return (
        <div className="space-y-2 text-xs">
          {/* Price move */}
          {snapshot.fromPrice != null && snapshot.toPrice != null && (
            <div className="flex items-center gap-2">
              <span className="text-foreground tabular-nums font-medium">
                ${String(snapshot.fromPrice)} &rarr; ${String(snapshot.toPrice)}
              </span>
              {step != null && maxSteps != null && (
                <span className="text-muted-foreground">step {step}/{maxSteps}</span>
              )}
              {step != null && maxSteps == null && (
                <span className="text-muted-foreground">step {step}</span>
              )}
            </div>
          )}
          {/* Chase range */}
          {initialLimit != null && chaseLimit != null && (
            <div className="flex items-center gap-3 text-muted-foreground">
              <span>Range: ${initialLimit} → ${chaseLimit}</span>
              {stepAmount != null && <span>${stepAmount}/step</span>}
            </div>
          )}
          {/* Progress bar */}
          {initialLimit != null && chaseLimit != null && snapshot.toPrice != null && (
            <div className="w-full bg-muted/40 rounded-full h-1.5">
              <div
                className="bg-[oklch(0.60_0.08_75)] h-1.5 rounded-full transition-all"
                style={{ width: `${Math.min(100, Math.abs(Number(snapshot.toPrice) - initialLimit) / Math.abs(chaseLimit - initialLimit) * 100)}%` }}
              />
            </div>
          )}
          {/* Fallback */}
          {snapshot.fromPrice == null && <FallbackJson data={snapshot} />}
        </div>
      );
    }
    case 'QUOTE_FAILED':
    case 'RETRY_LLM':
      return <ErrorView data={snapshot} />;
    case 'SETTLED':
      return <SettledView data={snapshot} reasoning={reasoning} />;
    default:
      return <FallbackJson data={snapshot} />;
  }
}

// ─── Decision Popover ────────────────────────────────

export function DecisionPopover({ d }: { d: RunDecision }) {
  const event = d.event ?? 'SETTLED';
  const snapshot = d.snapshot as Record<string, unknown> | null;
  const hasContent = d.outcome || d.reasoning || d.skipCategory || d.phase || snapshot;
  const label = event === 'SETTLED' && d.phase === 'orchestrator' ? 'SUMMARY' : (EVENT_LABEL[event] ?? event);

  return (
    <PopoverContent align="start" side="right" className="w-96 max-h-[420px] overflow-auto p-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <Badge label={label} />
        {d.outcome && <Badge label={d.outcome} />}
        {d.phase && <Badge label={PATH_LABEL[d.phase] ?? d.phase} />}
        {d.skipCategory && (
          <span className="text-[10px] text-muted-foreground">{d.skipCategory}</span>
        )}
        {event === 'PARSED' && snapshot?.route != null && (
          <Badge label={String(snapshot.route) === 'orchestrator' ? 'Agent' : String(snapshot.route) === 'deterministic' ? 'Deterministic' : String(snapshot.route)} />
        )}
        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground tabular-nums">
          {d.durationMs != null && d.durationMs > 10 && <span>{fmtMs(d.durationMs)}</span>}
          {d.inputTokens != null && d.outputTokens != null && (
            <span>{d.inputTokens.toLocaleString()}/{d.outputTokens.toLocaleString()} tok</span>
          )}
        </div>
      </div>

      <div className="px-3 py-2 space-y-3">
        {/* Snapshot detail */}
        {snapshot && Object.keys(snapshot).length > 0 && (
          <SnapshotDispatch event={event} snapshot={snapshot} reasoning={d.reasoning} />
        )}

        {/* Reasoning (skip for SETTLED since SettledView already shows it) */}
        {d.reasoning && event !== 'SETTLED' && (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Reasoning</p>
            <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">{d.reasoning}</p>
          </div>
        )}

        {/* No useful data fallback */}
        {!hasContent && (
          <p className="text-xs text-muted-foreground/50 italic">No decision data recorded for this entry.</p>
        )}

        {/* IDs */}
        <div className="border-t border-border pt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground/60 tabular-nums">
          {d.messageId && <span>msg {d.messageId.slice(0, 8)}</span>}
          {d.tradeId && <span>trade {d.tradeId.slice(0, 8)}</span>}
          {d.signalIndex != null && <span>sig #{d.signalIndex}</span>}
          <span>id {d.id.slice(0, 8)}</span>
        </div>
      </div>
    </PopoverContent>
  );
}

// ─── Trade event popover ─────────────────────────────

function TradeEventPopover({ ev, fillInfo, tradePnl, trade }: {
  ev: TradeEvent;
  fillInfo?: { orderId?: string; orderType?: string; limitPrice?: number; filledPrice?: number; adjustmentCount?: number; commission?: number; originalLimitPrice?: number; immediatelyFilled?: boolean; signalLimitPrice?: number };
  tradePnl?: string | null;
  trade?: { entryPrice?: string | null; openedAt?: string | null; quantity?: number | null; strategy?: string | null; direction?: string | null };
}) {
  const price = safeParseFloat(ev.price);
  const meta = ev.metadata as Record<string, unknown> | null;
  const multiplier = ev.strategy === 'STOCK' ? 1 : 100;

  return (
    <PopoverContent align="start" side="right" className="w-80 p-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <Badge label={ev.action} />
        {ev.strategy && <Badge label={ev.strategy} />}
        {fillInfo?.orderId && (
          <span className="text-[10px] text-muted-foreground font-mono">#{fillInfo.orderId}</span>
        )}
      </div>
      <div className="px-3 py-2 space-y-2 text-xs">
        {/* OPEN: Position snapshot */}
        {ev.action === 'OPEN' && (() => {
          const notional = price != null && ev.quantity != null ? price * ev.quantity * multiplier : null;
          return (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <StatItem label="Cost Basis">
                  <span className="text-foreground tabular-nums font-medium">{formatCurrency(price)}/ct</span>
                </StatItem>
                <StatItem label="Contracts">
                  <span className="text-foreground tabular-nums font-medium">{ev.quantity}</span>
                </StatItem>
                {notional != null && (
                  <StatItem label="Notional">
                    <span className="text-foreground tabular-nums">{formatCurrency(notional)}</span>
                  </StatItem>
                )}
              </div>
            </>
          );
        })()}

        {/* CLOSE: Trade outcome */}
        {ev.action === 'CLOSE' && (() => {
          const entryPrice = trade?.entryPrice != null ? safeParseFloat(trade.entryPrice) : null;
          const pnl = tradePnl != null ? parseFloat(tradePnl) : null;
          const entryNotional = entryPrice != null && ev.quantity != null ? entryPrice * ev.quantity * multiplier : null;
          const returnPct = pnl != null && entryNotional != null && entryNotional !== 0 ? (pnl / entryNotional) * 100 : null;
          const openedAt = trade?.openedAt;
          let holdDuration: string | null = null;
          if (openedAt) {
            const ms = new Date(ev.timestamp).getTime() - new Date(openedAt).getTime();
            if (ms > 0) {
              const hours = Math.floor(ms / 3600000);
              const mins = Math.floor((ms % 3600000) / 60000);
              if (hours >= 24) {
                const days = Math.floor(hours / 24);
                holdDuration = `${days}d ${hours % 24}h`;
              } else {
                holdDuration = `${hours}h ${mins}m`;
              }
            }
          }
          return (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {entryPrice != null && (
                <StatItem label="Entry">
                  <span className="text-foreground tabular-nums">{formatCurrency(entryPrice)}</span>
                </StatItem>
              )}
              <StatItem label="Exit">
                <span className="text-foreground tabular-nums">{formatCurrency(price)}</span>
              </StatItem>
              {pnl != null && pnl !== 0 && (
                <StatItem label="P&L">
                  <span className={cn('tabular-nums font-medium', pnlColor(tradePnl!))}>
                    {formatCurrency(pnl)}{returnPct != null ? ` (${returnPct > 0 ? '+' : ''}${returnPct.toFixed(0)}%)` : ''}
                  </span>
                </StatItem>
              )}
              {holdDuration && (
                <StatItem label="Duration">
                  <span className="text-foreground tabular-nums">{holdDuration}</span>
                </StatItem>
              )}
              {fillInfo?.commission != null && fillInfo.commission > 0 && (
                <StatItem label="Commission">
                  <span className="text-foreground tabular-nums">{formatCurrency(fillInfo.commission)}</span>
                </StatItem>
              )}
            </div>
          );
        })()}

        {/* TRIM: Position transition */}
        {ev.action === 'TRIM' && (() => {
          const trimPnl = meta?.trimPnl as number | undefined;
          const exitPct = meta?.exitPercent as number | undefined;
          return (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <StatItem label="Trimmed">
                <span className="text-foreground tabular-nums">-{ev.quantity}{exitPct != null ? ` (${Math.round(exitPct * 100)}%)` : ''}</span>
              </StatItem>
              <StatItem label="Exit Price">
                <span className="text-foreground tabular-nums">{formatCurrency(price)}</span>
              </StatItem>
              {trimPnl != null && (
                <StatItem label="Trim P&L">
                  <span className={cn('tabular-nums font-medium', trimPnl > 0 ? 'text-profit' : 'text-loss')}>{formatCurrency(trimPnl)}</span>
                </StatItem>
              )}
            </div>
          );
        })()}

        {/* ADD: Scaling */}
        {ev.action === 'ADD' && (() => {
          return (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <StatItem label="Added">
                <span className="text-foreground tabular-nums">+{ev.quantity}</span>
              </StatItem>
              <StatItem label="Add Price">
                <span className="text-foreground tabular-nums">{formatCurrency(price)}</span>
              </StatItem>
              {trade?.entryPrice != null && (
                <StatItem label="Avg Basis">
                  <span className="text-foreground tabular-nums">{formatCurrency(safeParseFloat(trade.entryPrice))}</span>
                </StatItem>
              )}
            </div>
          );
        })()}

        {/* LEG_OFF: Structural change */}
        {ev.action === 'LEG_OFF' && (() => {
          const targetStrategy = meta?.targetStrategy as string | undefined;
          const closedLeg = meta?.closedLeg as { type?: string; strike?: number; action?: string; fillPrice?: number } | undefined;
          const legPnl = computeLegOffPnl(meta, price, ev.quantity, ev.strategy);
          const cost = computeLegOffCost(price, ev.quantity, ev.strategy);
          const legDesc = closedLeg ? `${closedLeg.action === 'SELL' ? 'Short' : 'Long'} ${closedLeg.strike}${closedLeg.type === 'CALL' ? 'C' : closedLeg.type === 'PUT' ? 'P' : ''}` : null;
          return (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {legDesc && (
                <StatItem label="Closed Leg">
                  <span className="text-foreground text-xs">{legDesc}</span>
                </StatItem>
              )}
              {closedLeg?.fillPrice != null && (
                <StatItem label={`${closedLeg.action === 'SELL' ? 'Sold' : 'Bought'} At`}>
                  <span className="text-foreground tabular-nums">{formatCurrency(closedLeg.fillPrice)}</span>
                </StatItem>
              )}
              <StatItem label="Buyback">
                <span className="text-foreground tabular-nums">{formatCurrency(price)}/ct</span>
              </StatItem>
              {cost != null && (
                <StatItem label="Cost">
                  <span className="text-foreground tabular-nums">{formatCurrency(cost)}</span>
                </StatItem>
              )}
              {legPnl != null && (
                <StatItem label="Leg P&L">
                  <span className={cn('tabular-nums font-medium', legPnl > 0 ? 'text-profit' : 'text-loss')}>{formatCurrency(legPnl)}</span>
                </StatItem>
              )}
              {targetStrategy && (
                <StatItem label="New Strategy">
                  <Badge label={targetStrategy} />
                </StatItem>
              )}
            </div>
          );
        })()}
      </div>
      <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground/60 tabular-nums">
        {formatDate(ev.timestamp)}
      </div>
    </PopoverContent>
  );
}

// ─── Leg-off PnL helper ──────────────────────────────

/** Compute realized PnL on the closed leg. Uses pre-computed value from metadata
 *  if available, otherwise derives from closedLeg.fillPrice + buyback price. */
function computeLegOffPnl(
  meta: Record<string, unknown> | null,
  buybackPrice: number | null,
  quantity: number | null,
  strategy: string | null,
): number | undefined {
  if (meta?.legOffPnl != null) return meta.legOffPnl as number;
  if (buybackPrice == null) return undefined;
  const closedLeg = meta?.closedLeg as { action?: string; fillPrice?: number; type?: string } | undefined;
  if (closedLeg?.fillPrice == null) return undefined;
  const qty = quantity ?? 1;
  const mult = (strategy === 'STOCK' || closedLeg.type === 'STOCK') ? 1 : 100;
  const dir = closedLeg.action === 'BUY' ? 1 : -1; // BUY=LONG, SELL=SHORT
  return Math.round((buybackPrice - closedLeg.fillPrice) * dir * qty * mult * 100) / 100 || 0;
}

/** Cost of the leg-off as a dollar amount (debit paid for buyback). */
function computeLegOffCost(
  buybackPrice: number | null,
  quantity: number | null,
  strategy: string | null,
): number | null {
  if (buybackPrice == null) return null;
  const qty = quantity ?? 1;
  const mult = strategy === 'STOCK' ? 1 : 100;
  return Math.round(buybackPrice * qty * mult * 100) / 100;
}

// ─── Unified timeline ────────────────────────────────

type Entry =
  | { kind: 'decision'; sortKey: string; data: RunDecision }
  | { kind: 'trade'; sortKey: string; data: TradeEvent };

export function UnifiedTimeline() {
  const story = useTradesStore((s) => s.story);
  if (!story) return null;

  const { decisions, events: tradeEvents, trade, timelineMessages: messages } = story;
  const closeMessageId = trade.closeMessageId;
  const tradePnl = trade.pnl;

  const msgMap = new Map((messages ?? []).map(m => [m.id, m]));
  const filtered = filterRedundantSettled(decisions);

  // Build per-message fill context for trade event popovers
  const fillInfoByMsg = new Map<string, {
    orderId?: string; orderType?: string; limitPrice?: number;
    filledPrice?: number; adjustmentCount?: number; commission?: number;
    originalLimitPrice?: number; immediatelyFilled?: boolean;
    filledQuantity?: number; signalLimitPrice?: number;
  }>();
  for (const d of decisions) {
    const snap = d.snapshot as Record<string, unknown> | null;
    if (!snap || !d.messageId) continue;
    const existing = fillInfoByMsg.get(d.messageId) ?? {};
    if (d.event === 'ORDER_PLACED') {
      const params = snap.params as Record<string, unknown> | undefined;
      existing.orderId = snap.orderId ? String(snap.orderId) : existing.orderId;
      existing.orderType = params?.orderType ? String(params.orderType) : existing.orderType;
      existing.limitPrice = params?.limitPrice != null ? Number(params.limitPrice) : existing.limitPrice;
    }
    if (d.event === 'ORDER_FILLED') {
      const params = snap.params as Record<string, unknown> | undefined;
      existing.orderId = snap.orderId ? String(snap.orderId) : existing.orderId;
      existing.filledPrice = snap.filledPrice != null ? Number(snap.filledPrice) : existing.filledPrice;
      existing.adjustmentCount = snap.adjustmentCount != null ? Number(snap.adjustmentCount) : existing.adjustmentCount;
      existing.commission = snap.commission != null ? Number(snap.commission) : existing.commission;
      existing.originalLimitPrice = params?.limitPrice != null ? Number(params.limitPrice) : existing.originalLimitPrice;
      existing.immediatelyFilled = snap.immediatelyFilled === true;
      existing.filledQuantity = snap.filledQuantity != null ? Number(snap.filledQuantity) : existing.filledQuantity;
    }
    if (d.event === 'SIGNAL_RESOLVED') {
      const sigLimit = snap.limitPrice;
      if (sigLimit != null) existing.signalLimitPrice = Math.abs(Number(sigLimit));
    }
    fillInfoByMsg.set(d.messageId, existing);
  }

  const eventOrder: Record<string, number> = {
    PARSED: 0, SIGNAL_RESOLVED: 1, SIZED: 2, ORDER_PLACED: 3,
    ORDER_ADJUSTED: 4, ORDER_CANCELLED: 5, ORDER_FILLED: 5, SETTLED: 6,
    QUOTE_FAILED: 4, RETRY_LLM: 4,
  };

  const entries: Entry[] = [];

  for (const d of filtered) {
    const event = d.event ?? 'SETTLED';

    // Hide SETTLED FAIL when a more specific event already explains the outcome
    if (event === 'SETTLED' && d.outcome === 'FAIL') {
      const sameSignal = (other: RunDecision) =>
        other.messageId === d.messageId && other.signalIndex === d.signalIndex;
      if (filtered.some(o => o.event === 'ORDER_FILLED' && sameSignal(o))) continue;
      if (filtered.some(o => o.event === 'ORDER_CANCELLED' && sameSignal(o))) continue;
    }

    // Hide orchestrator SUMMARY when ORDER_CANCELLED already provides the terminal state
    if (event === 'SETTLED' && d.phase === 'orchestrator') {
      const hasCancel = filtered.some(
        o => o.event === 'ORDER_CANCELLED' && o.messageId === d.messageId,
      );
      if (hasCancel) continue;
    }

    // Hide entries with no visible content (empty shell rows from transitional emitter)
    const dec = d.outcome as string | null;
    const hasVisibleData = dec || d.reasoning || d.skipCategory || d.pnl || d.inputTokens != null || d.snapshot;
    if (event === 'SETTLED' && !hasVisibleData) continue;

    const msgTs = d.messageId ? msgMap.get(d.messageId)?.timestamp : undefined;
    const baseTs = msgTs ?? d.createdAt ?? '';
    const order = eventOrder[event] ?? 5;
    const sortKey = `${baseTs}|0|${String(order).padStart(2, '0')}|${d.signalIndex ?? 0}`;
    entries.push({ kind: 'decision', sortKey, data: d });
  }

  for (const e of tradeEvents) {
    entries.push({ kind: 'trade', sortKey: `${e.timestamp}|1|00|0`, data: e });
  }

  entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  if (entries.length === 0) return null;

  let prevMsgId: string | null = null;

  return (
    <div className="min-w-0 overflow-hidden">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-4">
        Execution Timeline
      </h3>

      <div className="relative pl-[30px] min-w-0">
        {/* Vertical rail */}
        <div className="absolute top-0 bottom-0 w-px bg-border/40" style={{ left: '12px' }} />

          {entries.map((entry, i) => {
            const isLast = i === entries.length - 1;
            const prev = i > 0 ? entries[i - 1] : null;

            const curMsgId = entry.kind === 'decision' ? entry.data.messageId : null;
            const isPhaseBreak = i > 0 && (
              (entry.kind === 'decision' && prev?.kind === 'trade') ||
              (entry.kind === 'decision' && curMsgId && prevMsgId && curMsgId !== prevMsgId)
            );
            if (curMsgId) prevMsgId = curMsgId;

            if (entry.kind === 'trade') {
              const ev = entry.data;
              const price = safeParseFloat(ev.price);
              const meta = ev.metadata as Record<string, unknown> | null;
              const trimPnl = meta?.trimPnl as number | undefined;
              const legOffPnl = computeLegOffPnl(meta, price, ev.quantity, ev.strategy);
              const legOffCost = legOffPnl == null ? computeLegOffCost(price, ev.quantity, ev.strategy) : null;
              const info = ev.messageId ? fillInfoByMsg.get(ev.messageId) : undefined;
              const evLegs = ev.legs;
              const evStrategy = ev.strategy ?? '';
              const contractDesc = formatLegsSummary(evLegs, evStrategy);

              return (
                <Popover key={ev.id}>
                  <div className={cn('relative', i > 0 && 'mt-1.5', !isLast && 'pb-1.5')}>
                    {/* 13px dot — trade events are primary anchors */}
                    <div
                      className={cn('absolute w-[13px] h-[13px] rounded-full ring-2 ring-background', DOT[ev.action] ?? 'bg-muted-foreground/40')}
                      style={{ left: '-24.5px', top: '2px' }}
                    />
                    <PopoverTrigger asChild>
                      <button type="button" className="flex items-center gap-2 flex-wrap min-w-0 w-full text-left cursor-pointer hover:opacity-80">
                        <span className="text-[13px] font-bold text-foreground tracking-tight">
                          {ACTION_LABEL[ev.action] ?? ev.action}
                        </span>
                        {contractDesc && (
                          <span className="text-[11px] text-muted-foreground tabular-nums">
                            {contractDesc}
                          </span>
                        )}
                        <span className="text-[13px] font-semibold text-foreground/90 tabular-nums">
                          {ev.action === 'TRIM' && '\u2212'}{ev.action === 'ADD' && '+'}{ev.quantity} @ {formatCurrency(price)}
                        </span>
                        {ev.action === 'CLOSE' && tradePnl != null && parseFloat(tradePnl) !== 0 && (
                          <span className={cn('text-xs font-semibold tabular-nums', pnlColor(tradePnl))}>
                            {formatCurrency(tradePnl)}
                          </span>
                        )}
                        {trimPnl != null && (
                          <span className={cn('text-xs font-semibold tabular-nums', trimPnl > 0 ? 'text-profit' : 'text-loss')}>
                            {formatCurrency(trimPnl)}
                          </span>
                        )}
                        {legOffPnl != null && (
                          <span className={cn('text-xs font-semibold tabular-nums', legOffPnl > 0 ? 'text-profit' : 'text-loss')}>
                            {formatCurrency(legOffPnl)}
                          </span>
                        )}
                        {legOffCost != null && (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {formatCurrency(-legOffCost)} debit
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground/60 tabular-nums ml-auto shrink-0">
                          {formatDate(ev.timestamp)}
                        </span>
                      </button>
                    </PopoverTrigger>
                  </div>
                  <TradeEventPopover ev={ev} fillInfo={info} tradePnl={tradePnl} trade={trade} />
                </Popover>
              );
            }

            // ─── Decision entry ──────────────────────
            const d = entry.data as RunDecision;
            const event = d.event ?? 'SETTLED';
            const isFail = d.outcome === 'FAIL';
            const isSkip = d.outcome === 'SKIP';
            const eventLabel = event === 'SETTLED' && d.phase === 'orchestrator' ? 'SUMMARY' : (EVENT_LABEL[event] ?? event);
            const inlineSummary = getInlineSummary(d);
            const msgTs = event === 'PARSED' && d.messageId ? msgMap.get(d.messageId)?.timestamp : undefined;

            // ─── Promoted ORDER_CANCELLED — trade-event weight ───
            if (event === 'ORDER_CANCELLED') {
              const snap = d.snapshot as Record<string, unknown> | null;
              const cancelOrder = snap?.order as Record<string, unknown> | undefined;
              const cancelParams = cancelOrder?.params as Record<string, unknown> | undefined;
              const symbol = cancelParams?.symbol ? String(cancelParams.symbol) : null;
              const parsedDecision = filtered.find(
                o => o.event === 'PARSED' && o.messageId === d.messageId && o.signalIndex === d.signalIndex,
              );
              const parsedSnap = parsedDecision?.snapshot as Record<string, unknown> | null;
              const action = parsedSnap?.action ? String(parsedSnap.action) : null;
              const label = action === 'CLOSE' ? 'Close Failed' : action === 'OPEN' ? 'Open Failed' : 'Order Failed';
              const cancelTs = d.messageId ? msgMap.get(d.messageId)?.timestamp : undefined;

              return (
                <Popover key={d.id}>
                  <div className={cn('relative', i > 0 && 'mt-1.5', !isLast && 'pb-1.5')}>
                    <div
                      className="absolute w-[13px] h-[13px] rounded-full ring-2 ring-background bg-loss"
                      style={{ left: '-24.5px', top: '2px' }}
                    />
                    <PopoverTrigger asChild>
                      <button type="button" className="flex items-center gap-2 flex-wrap min-w-0 cursor-pointer hover:opacity-80 text-left">
                        <span className="text-[13px] font-bold text-loss tracking-tight">
                          {label}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          order cancelled{symbol ? ` — ${symbol}` : ''}
                        </span>
                        {cancelTs && (
                          <span className="text-[11px] text-muted-foreground/60 tabular-nums ml-auto shrink-0">
                            {formatDate(cancelTs)}
                          </span>
                        )}
                      </button>
                    </PopoverTrigger>
                  </div>
                  <DecisionPopover d={d} />
                </Popover>
              );
            }

            return (
              <Popover key={d.id}>
                <div className={cn(
                  'relative min-w-0 overflow-hidden',
                  isPhaseBreak && 'mt-4 pt-3 before:absolute before:left-[-30px] before:right-0 before:top-0 before:h-px before:bg-border/50',
                  !isPhaseBreak && i > 0 && 'mt-0',
                  !isLast && 'pb-2.5',
                )}>
                  {/* 8px dot — decisions are supporting context */}
                  <div
                    className={cn('absolute w-[8px] h-[8px] rounded-full ring-2 ring-background', DOT[event] ?? 'bg-muted-foreground/30')}
                    style={{ left: '-22px', top: '5px' }}
                  />

                  {/* Header: event label (popover trigger) + inline summary + outcome + metrics */}
                  <div className="flex items-center gap-1.5 min-w-0">
                    <PopoverTrigger asChild>
                      <button type="button" className={cn(
                        'text-[10px] font-bold uppercase tracking-wider shrink-0 hover:underline underline-offset-2 cursor-pointer',
                        isFail ? 'text-loss/80' : 'text-foreground/60',
                      )}>
                        {eventLabel}
                      </button>
                    </PopoverTrigger>

                    {inlineSummary && (
                      <span className="text-[10px] text-muted-foreground/50 truncate max-w-[200px]">
                        {inlineSummary}
                      </span>
                    )}

                    {d.outcome && <Badge label={d.outcome} />}
                    {d.skipCategory && (
                      <span className="text-[10px] text-muted-foreground/60 truncate max-w-[180px]">{d.skipCategory}</span>
                    )}

                    <div className="flex items-center gap-1.5 ml-auto shrink-0">
                      {/* PnL intentionally not shown here — displayed on the CLOSE trade event instead */}
                      {d.inputTokens != null && d.outputTokens != null && (
                        <span className="text-[10px] text-muted-foreground/50 tabular-nums">{d.inputTokens.toLocaleString()}/{d.outputTokens.toLocaleString()}</span>
                      )}
                      {d.durationMs != null && d.durationMs > 10 && (
                        <span className="text-[10px] text-muted-foreground/50 tabular-nums">{fmtMs(d.durationMs)}</span>
                      )}
                      {msgTs && (
                        <span className="text-[11px] text-muted-foreground/60 tabular-nums">{formatDate(msgTs)}</span>
                      )}
                    </div>
                  </div>

                  {/* Reasoning on its own line — not crammed with badges */}
                  {d.reasoning && (
                    <p className={cn(
                      'text-[11px] mt-1 leading-relaxed line-clamp-2 break-words',
                      isFail ? 'text-loss/60' : isSkip ? 'text-muted-foreground/50' : 'text-foreground/60',
                    )}>
                      {d.reasoning}
                    </p>
                  )}

                  {/* Message quote for PARSED and SETTLED FAIL events */}
                  {(event === 'PARSED' || (event === 'SETTLED' && isFail)) && d.messageId && msgMap.has(d.messageId) && (() => {
                    const msg = msgMap.get(d.messageId)!;
                    return (
                      <div className="mt-1.5 border-l-2 border-foreground/20 pl-2">
                        <p className="text-[11px] text-foreground/50 italic line-clamp-2 break-words">
                          {msg.cleanText}
                        </p>
                        {msg.reactions.length > 0 && (
                          <span className="inline-flex gap-1 mt-1">
                            {msg.reactions.map((r) => (
                              <span key={r.Type} className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/60 bg-muted/40 rounded px-1 py-px">
                                <span>{REACTION_EMOJI[r.Type] ?? r.Type}</span>
                                {r.Count > 1 && <span className="tabular-nums">{r.Count}</span>}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
                <DecisionPopover d={d} />
              </Popover>
            );
          })}
      </div>
    </div>
  );
}
