'use client';

import { Badge } from './badge';
import { StatItem } from './stat-item';
import { cn } from '@/lib/utils';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { safeParseFloat } from '@src/lib/numbers';
import type { RunDecision, TradeEvent } from '@src/db/schema';
import type { TimelineMessage } from '../trades/actions';
import { useTradesStore } from '@/stores/trades-store';
import {
  ParseResultView, SignalView, SizedView, OrderPlacedView, OrderFilledView,
  OrderCancelledView, SettledView, ErrorView, FallbackJson,
} from './snapshot-detail';

// ─── Utilities ───────────────────────────────────────

function fmtMs(ms: number) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }

// ─── Visual constants ────────────────────────────────

const EVENT_LABEL: Record<string, string> = {
  PARSED: 'PARSED', SIGNAL_RESOLVED: 'SIGNAL', SIZED: 'SIZED',
  ORDER_PLACED: 'ORDER', ORDER_ADJUSTED: 'CHASE', ORDER_FILLED: 'FILLED',
  ORDER_CANCELLED: 'CANCELLED', QUOTE_FAILED: 'QUOTE FAIL', RETRY_LLM: 'RETRY', SETTLED: 'RESULT',
};

const ACTION_LABEL: Record<string, string> = {
  OPEN: 'Opened', CLOSE: 'Closed', TRIM: 'Trimmed', ADD: 'Added', LEG_OFF: 'Leg Off',
};

const PATH_LABEL: Record<string, string> = {
  orchestrator: 'Agent', deterministic: 'Deterministic',
  skipped: 'Hard Skip', pipeline_failure: 'Pipeline Fail',
};

const DOT: Record<string, string> = {
  PARSED: 'bg-[oklch(0.62_0.05_248)]', SIGNAL_RESOLVED: 'bg-[oklch(0.58_0.07_328)]',
  SIZED: 'bg-[oklch(0.58_0.06_178)]', ORDER_PLACED: 'bg-[oklch(0.55_0.08_148)]',
  ORDER_ADJUSTED: 'bg-[oklch(0.60_0.08_75)]', ORDER_FILLED: 'bg-[oklch(0.52_0.10_148)]',
  ORDER_CANCELLED: 'bg-[oklch(0.55_0.15_25)]', QUOTE_FAILED: 'bg-[oklch(0.52_0.12_30)]', RETRY_LLM: 'bg-[oklch(0.60_0.08_75)]',
  SETTLED: 'bg-[oklch(0.50_0.02_65)]',
  OPEN: 'bg-[oklch(0.48_0.14_148)]', CLOSE: 'bg-[oklch(0.48_0.12_248)]',
  ADD: 'bg-[oklch(0.48_0.10_178)]', TRIM: 'bg-[oklch(0.55_0.12_75)]',
  LEG_OFF: 'bg-[oklch(0.50_0.10_328)]',
};

// ─── Inline summary extraction ──────────────────────

function getInlineSummary(d: RunDecision): string | null {
  const snap = d.snapshot as Record<string, unknown> | null;
  if (!snap) return null;
  const event = d.event ?? 'SETTLED';

  switch (event) {
    case 'PARSED': {
      const parts = [snap.action, snap.symbol, snap.strategy].filter(Boolean).map(String);
      return parts.length > 0 ? parts.join(' ') : null;
    }
    case 'SIGNAL_RESOLVED': {
      const legs = Array.isArray(snap.legs) ? snap.legs as { symbol?: string }[] : [];
      const symbol = legs[0]?.symbol ?? snap.symbol;
      const type = legs.length === 1 ? 'SINGLE' : legs.length === 2 ? 'SPREAD' : `${legs.length}-LEG`;
      return symbol ? `${type} ${symbol}` : type;
    }
    case 'SIZED': {
      if (snap.quantity != null && snap.entryPrice != null) return `${snap.quantity} @ $${snap.entryPrice}`;
      if (snap.quantity != null) return `qty ${snap.quantity}`;
      return null;
    }
    case 'ORDER_PLACED': {
      const parts: string[] = [];
      if (snap.orderId) parts.push(`#${snap.orderId}`);
      if (snap.limitPrice != null) parts.push(`limit $${snap.limitPrice}`);
      return parts.length > 0 ? parts.join(' ') : null;
    }
    case 'ORDER_ADJUSTED': {
      if (snap.fromPrice != null && snap.toPrice != null) return `$${snap.fromPrice} \u2192 $${snap.toPrice}`;
      return null;
    }
    case 'ORDER_FILLED': {
      const parts: string[] = [];
      if (snap.filledPrice != null) parts.push(`$${snap.filledPrice}`);
      if (snap.adjustmentCount != null && Number(snap.adjustmentCount) > 0) parts.push(`(${snap.adjustmentCount} chases)`);
      return parts.length > 0 ? parts.join(' ') : null;
    }
    case 'QUOTE_FAILED':
      return snap.occSymbol ? String(snap.occSymbol) : null;
    case 'RETRY_LLM':
      return snap.reason ? String(snap.reason) : null;
    case 'ORDER_CANCELLED': {
      const parts: string[] = [];
      if (snap.symbol) parts.push(String(snap.symbol));
      if (snap.originalLimitPrice != null && snap.finalLimitPrice != null &&
          snap.originalLimitPrice !== snap.finalLimitPrice) {
        parts.push(`$${snap.originalLimitPrice} → $${snap.finalLimitPrice}`);
      } else if (snap.finalLimitPrice != null) {
        parts.push(`$${snap.finalLimitPrice}`);
      }
      return parts.length > 0 ? parts.join(' ') : null;
    }
    default:
      return null;
  }
}

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

function SnapshotDispatch({ event, snapshot, reasoning }: { event: string; snapshot: Record<string, unknown>; reasoning?: string | null }) {
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
    case 'ORDER_ADJUSTED':
      return (
        <div className="flex items-center gap-2 text-xs">
          {snapshot.fromPrice != null && snapshot.toPrice != null ? (
            <span className="text-foreground tabular-nums">
              ${String(snapshot.fromPrice)} &rarr; ${String(snapshot.toPrice)}
              {snapshot.step != null && (
                <span className="text-muted-foreground ml-1">(step {String(snapshot.step)})</span>
              )}
            </span>
          ) : (
            <FallbackJson data={snapshot} />
          )}
        </div>
      );
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

function DecisionPopover({ d }: { d: RunDecision }) {
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

function TradeEventPopover({ ev, fillInfo, tradePnl }: {
  ev: TradeEvent;
  fillInfo?: { orderId?: string; orderType?: string; limitPrice?: number; filledPrice?: number; adjustmentCount?: number; commission?: number; originalLimitPrice?: number; immediatelyFilled?: boolean };
  tradePnl?: string | null;
}) {
  const price = safeParseFloat(ev.price);
  const meta = ev.metadata as Record<string, unknown> | null;
  const limitPrice = fillInfo?.originalLimitPrice ?? fillInfo?.limitPrice;
  const slippage = limitPrice != null && price != null ? price - limitPrice : null;

  return (
    <PopoverContent align="start" side="right" className="w-80 p-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <Badge label={ev.action} />
        {fillInfo?.orderType && <Badge label={fillInfo.orderType} />}
        {fillInfo?.orderId && (
          <span className="text-[10px] text-muted-foreground font-mono">#{fillInfo.orderId}</span>
        )}
      </div>
      <div className="px-3 py-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {price != null && (
          <StatItem label="Fill Price">
            <span className="text-foreground tabular-nums font-medium">{formatCurrency(price)}</span>
          </StatItem>
        )}
        {limitPrice != null && (
          <StatItem label="Limit Price">
            <span className="text-foreground tabular-nums">{formatCurrency(limitPrice)}</span>
          </StatItem>
        )}
        {slippage != null && slippage !== 0 && (
          <StatItem label="Slippage">
            <span className={cn('tabular-nums', slippage > 0 ? 'text-loss' : 'text-profit')}>
              {slippage > 0 ? '+' : ''}{formatCurrency(slippage)}
            </span>
          </StatItem>
        )}
        {fillInfo?.adjustmentCount != null && fillInfo.adjustmentCount > 0 && (
          <StatItem label="Chases">
            <span className="text-foreground tabular-nums">{fillInfo.adjustmentCount}</span>
          </StatItem>
        )}
        {fillInfo?.immediatelyFilled && (
          <StatItem label="Fill">
            <span className="text-profit text-[10px]">Immediate</span>
          </StatItem>
        )}
        {fillInfo?.commission != null && fillInfo.commission > 0 && (
          <StatItem label="Commission">
            <span className="text-foreground tabular-nums">{formatCurrency(fillInfo.commission)}</span>
          </StatItem>
        )}
        {ev.quantity != null && (
          <StatItem label="Quantity">
            <span className="text-foreground tabular-nums">{ev.quantity}</span>
          </StatItem>
        )}
        {ev.action === 'CLOSE' && tradePnl != null && parseFloat(tradePnl) !== 0 && (
          <StatItem label="P&L">
            <span className={cn('tabular-nums font-medium', pnlColor(tradePnl))}>{formatCurrency(tradePnl)}</span>
          </StatItem>
        )}
        {ev.action === 'TRIM' && meta?.trimPnl != null && (
          <StatItem label="Trim P&L">
            <span className={cn('tabular-nums font-medium', pnlColor(meta.trimPnl as number))}>{formatCurrency(meta.trimPnl as number)}</span>
          </StatItem>
        )}
        {ev.action === 'TRIM' && meta?.exitPercent != null && (
          <StatItem label="Exit %">
            <span className="text-foreground tabular-nums">{(Number(meta.exitPercent) * 100).toFixed(0)}%</span>
          </StatItem>
        )}
      </div>
      <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground/60 tabular-nums">
        {formatDate(ev.timestamp)}
      </div>
    </PopoverContent>
  );
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
    filledQuantity?: number;
  }>();
  for (const d of decisions) {
    const snap = d.snapshot as Record<string, unknown> | null;
    if (!snap || !d.messageId) continue;
    const existing = fillInfoByMsg.get(d.messageId) ?? {};
    if (d.event === 'ORDER_PLACED') {
      existing.orderId = snap.orderId ? String(snap.orderId) : existing.orderId;
      existing.orderType = snap.orderType ? String(snap.orderType) : existing.orderType;
      existing.limitPrice = snap.limitPrice != null ? Number(snap.limitPrice) : existing.limitPrice;
    }
    if (d.event === 'ORDER_FILLED') {
      existing.orderId = snap.orderId ? String(snap.orderId) : existing.orderId;
      existing.filledPrice = snap.filledPrice != null ? Number(snap.filledPrice) : existing.filledPrice;
      existing.adjustmentCount = snap.adjustmentCount != null ? Number(snap.adjustmentCount) : existing.adjustmentCount;
      existing.commission = snap.commission != null ? Number(snap.commission) : existing.commission;
      existing.originalLimitPrice = snap.originalLimitPrice != null ? Number(snap.originalLimitPrice) : existing.originalLimitPrice;
      existing.immediatelyFilled = snap.immediatelyFilled === true;
      existing.filledQuantity = snap.filledQuantity != null ? Number(snap.filledQuantity) : existing.filledQuantity;
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
              const info = ev.messageId ? fillInfoByMsg.get(ev.messageId) : undefined;

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
                        <span className="text-[11px] text-muted-foreground/60 tabular-nums ml-auto shrink-0">
                          {formatDate(ev.timestamp)}
                        </span>
                      </button>
                    </PopoverTrigger>
                  </div>
                  <TradeEventPopover ev={ev} fillInfo={info} tradePnl={tradePnl} />
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
              const symbol = snap?.symbol ? String(snap.symbol) : null;
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
                      <p className="mt-1.5 text-[11px] text-foreground/50 italic line-clamp-2 border-l-2 border-foreground/20 pl-2 break-words">
                        {msg.cleanText}
                      </p>
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
