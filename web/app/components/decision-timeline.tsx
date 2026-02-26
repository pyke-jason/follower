import { Badge } from './badge';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { safeParseFloat } from '../../../src/lib/numbers';
import type { RunDecision, TradeEvent } from '../../../src/db/schema';

// ─── Utilities ───────────────────────────────────────

function fmtMs(ms: number) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }

function stripNoise(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj))
    if (v != null && v !== false && v !== '' && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out;
}

type LegRow = { symbol?: string; strike?: number; expiry?: string; type?: string; action?: string; side?: string; quantity?: number };

// ─── Compact data display ────────────────────────────

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 text-[11px]">
      {k && <span className="text-muted-foreground">{k}</span>}
      <span className="text-foreground tabular-nums">{v}</span>
    </span>
  );
}

function LegChip({ leg }: { leg: LegRow }) {
  const action = leg.action ?? leg.side;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] bg-muted/50 border border-border/40 rounded px-1.5 py-0.5">
      <span className={cn(
        'font-semibold text-[10px]',
        action === 'BUY' ? 'text-profit' : 'text-loss',
      )}>{action}</span>
      <span className="font-medium text-foreground tabular-nums">{leg.quantity ?? 1}</span>
      <span className="text-foreground/80 tabular-nums">{leg.symbol}</span>
      {leg.strike != null && <span className="text-foreground/60 tabular-nums">{leg.strike}</span>}
      {leg.type && leg.type !== 'stock' && <span className="text-foreground/60 uppercase text-[9px]">{leg.type}</span>}
    </span>
  );
}

// ─── Event detail renderers ──────────────────────────

function ParseDetail({ snap }: { snap: Record<string, unknown> }) {
  const clean = stripNoise(snap);
  const strategy = clean.strategy ? String(clean.strategy) : null;
  const isStock = strategy?.toUpperCase() === 'STOCK';
  const route = clean.route ? String(clean.route) : null;
  const items: React.ReactNode[] = [];
  const shown = new Set<string>();

  // Route badge first — tells you how the message was processed
  if (route) {
    items.push(
      <span key="route" className={cn(
        'text-[9px] font-bold uppercase tracking-wider px-1 py-px rounded',
        route === 'deterministic' ? 'bg-[oklch(0.48_0.14_148)]/15 text-[oklch(0.60_0.14_148)]'
          : route === 'llm' ? 'bg-[oklch(0.55_0.12_300)]/15 text-[oklch(0.65_0.12_300)]'
          : 'bg-muted text-muted-foreground',
      )}>{route === 'hard-skip' ? 'SKIP' : route}</span>
    );
    shown.add('route');
  }

  for (const f of ['action', 'direction', 'strategy'] as const) {
    if (clean[f] != null) { items.push(<Badge key={f} label={String(clean[f])} />); shown.add(f); }
  }
  if (clean.symbol != null) { items.push(<Kv key="sym" k="" v={String(clean.symbol)} />); shown.add('symbol'); }
  const price = clean.premiumHint ?? clean.price;
  if (price != null) { items.push(<Kv key="px" k="~" v={formatCurrency(price as number)} />); shown.add('premiumHint'); shown.add('price'); }
  if (Array.isArray(clean.strikes) && !isStock) {
    items.push(<Kv key="str" k="strikes" v={(clean.strikes as number[]).join('/')} />);
  }
  shown.add('strikes');
  for (const f of ['expiry', 'expiryHint'] as const) {
    if (clean[f] != null) { items.push(<Kv key={f} k={f} v={String(clean[f])} />); shown.add(f); }
  }
  if (clean.exitPercent != null) {
    items.push(<Kv key="exit" k="exit" v={`${Math.round(Number(clean.exitPercent) * 100)}%`} />); shown.add('exitPercent');
  }
  if (clean.quantity != null) { items.push(<Kv key="qty" k="qty" v={String(clean.quantity)} />); shown.add('quantity'); }
  if (typeof clean.confidence === 'number') {
    items.push(<Kv key="conf" k="conf" v={`${(clean.confidence * 100).toFixed(0)}%`} />); shown.add('confidence');
  }
  for (const skip of ['isLotto', 'isStrangle', 'isHardSkip', 'complexityFlags']) shown.add(skip);
  for (const [k, v] of Object.entries(clean)) {
    if (!shown.has(k)) items.push(<Kv key={k} k={k} v={typeof v === 'object' ? JSON.stringify(v) : String(v)} />);
  }
  if (items.length === 0) return null;
  return <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap">{items}</div>;
}

function SignalDetail({ snap }: { snap: Record<string, unknown> }) {
  const legs = Array.isArray(snap.legs) ? (snap.legs as LegRow[]) : [];
  return (
    <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
      {snap.orderType != null && <Badge label={String(snap.orderType)} />}
      {snap.limitPrice != null && <Kv k="limit" v={formatCurrency(snap.limitPrice as number)} />}
      {legs.map((leg, i) => <LegChip key={i} leg={leg} />)}
    </div>
  );
}

function AdjustDetail({ snap }: { snap: Record<string, unknown> }) {
  return (
    <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[11px]">
      {snap.fromPrice != null && snap.toPrice != null && (
        <span className="tabular-nums text-foreground/80">
          {formatCurrency(snap.fromPrice as number)}
          <span className="text-muted-foreground mx-1">&rarr;</span>
          {formatCurrency(snap.toPrice as number)}
        </span>
      )}
      {snap.step != null && (
        <span className="text-muted-foreground/70 tabular-nums">&times;{String(snap.step)}</span>
      )}
    </div>
  );
}

function DecisionDetail({ d }: { d: RunDecision }) {
  const event = d.event ?? 'SETTLED';
  const snap = d.snapshot ? stripNoise(d.snapshot as Record<string, unknown>) : {};
  if (Object.keys(snap).length === 0) return null;

  const isParse = 'symbol' in snap && ('strategy' in snap || 'action' in snap || 'isLotto' in snap);
  const isSignal = 'orderType' in snap && 'legs' in snap;

  if (event === 'PARSED' || isParse) return <ParseDetail snap={snap} />;
  if (event === 'SIGNAL_RESOLVED' || isSignal) return <SignalDetail snap={snap} />;
  if (event === 'ORDER_ADJUSTED') return <AdjustDetail snap={snap} />;

  // SETTLED: only show non-duplicate data — skip signal/outcome (already shown above)
  if (event === 'SETTLED') {
    const rest = Object.entries(snap).filter(([k]) => !['outcome', 'signal', 'parseResult'].includes(k));
    if (rest.length === 0) return null;
    return (
      <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap">
        {rest.map(([k, v]) => <Kv key={k} k={k} v={typeof v === 'object' ? JSON.stringify(v) : String(v)} />)}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap">
      {Object.entries(snap).map(([k, v]) => (
        <Kv key={k} k={k} v={typeof v === 'object' ? JSON.stringify(v) : String(v)} />
      ))}
    </div>
  );
}

// ─── Visual constants ────────────────────────────────

const EVENT_LABEL: Record<string, string> = {
  PARSED: 'PARSED', SIGNAL_RESOLVED: 'SIGNAL', SIZED: 'SIZED',
  ORDER_PLACED: 'ORDER', ORDER_ADJUSTED: 'CHASE', ORDER_FILLED: 'FILLED',
  QUOTE_FAILED: 'QUOTE FAIL', RETRY_LLM: 'RETRY', SETTLED: 'RESULT',
};

const ACTION_LABEL: Record<string, string> = {
  OPEN: 'Opened', CLOSE: 'Closed', TRIM: 'Trimmed', ADD: 'Added', LEG_OFF: 'Leg Off',
};

const DOT: Record<string, string> = {
  PARSED: 'bg-[oklch(0.62_0.05_248)]', SIGNAL_RESOLVED: 'bg-[oklch(0.58_0.07_328)]',
  SIZED: 'bg-[oklch(0.58_0.06_178)]', ORDER_PLACED: 'bg-[oklch(0.55_0.08_148)]',
  ORDER_ADJUSTED: 'bg-[oklch(0.60_0.08_75)]', ORDER_FILLED: 'bg-[oklch(0.52_0.10_148)]',
  QUOTE_FAILED: 'bg-[oklch(0.52_0.12_30)]', RETRY_LLM: 'bg-[oklch(0.60_0.08_75)]',
  SETTLED: 'bg-[oklch(0.50_0.02_65)]',
  OPEN: 'bg-[oklch(0.48_0.14_148)]', CLOSE: 'bg-[oklch(0.48_0.12_248)]',
  ADD: 'bg-[oklch(0.48_0.10_178)]', TRIM: 'bg-[oklch(0.55_0.12_75)]',
  LEG_OFF: 'bg-[oklch(0.50_0.10_328)]',
};

// ─── Unified timeline ────────────────────────────────

export type TimelineMessage = { id: string; cleanText: string; author: string; timestamp: string };

type Entry =
  | { kind: 'decision'; sortKey: string; data: RunDecision }
  | { kind: 'trade'; sortKey: string; data: TradeEvent };

export function DecisionTimeline({ decisions }: { decisions: RunDecision[] }) {
  return <UnifiedTimeline decisions={decisions} tradeEvents={[]} />;
}

export function UnifiedTimeline({
  decisions, tradeEvents, closeMessageId, messages,
}: {
  decisions: RunDecision[];
  tradeEvents: TradeEvent[];
  closeMessageId?: string | null;
  messages?: TimelineMessage[];
}) {
  const msgMap = new Map((messages ?? []).map(m => [m.id, m]));
  const tradeActionSet = new Set(tradeEvents.map(e => e.action));

  const eventOrder: Record<string, number> = {
    PARSED: 0, SIGNAL_RESOLVED: 1, SIZED: 2, ORDER_PLACED: 3,
    ORDER_ADJUSTED: 4, ORDER_FILLED: 5, SETTLED: 6,
    QUOTE_FAILED: 4, RETRY_LLM: 4,
  };

  const entries: Entry[] = [];

  for (const d of decisions) {
    const msg = d.messageId ? msgMap.get(d.messageId) : null;
    const event = d.event ?? 'SETTLED';

    // Hide SETTLED FAIL when trade events prove the order actually filled
    if (event === 'SETTLED' && d.outcome === 'FAIL' && tradeActionSet.has('OPEN')) continue;

    const baseTs = msg?.timestamp ?? d.createdAt ?? '';
    const order = eventOrder[event] ?? 5;
    const sortKey = `${baseTs}|0|${String(order).padStart(2, '0')}|${d.signalIndex ?? 0}`;
    entries.push({ kind: 'decision', sortKey, data: d });
  }

  for (const e of tradeEvents) {
    entries.push({ kind: 'trade', sortKey: `${e.timestamp}|1|00|0`, data: e });
  }

  entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  if (entries.length === 0) return null;

  // Detect phase boundaries: entry decisions share one messageId, exit decisions share another.
  // Track prevMessageId to insert visual separators between phases.
  let prevMsgId: string | null = null;

  // Rail: all dots centered on x=12px. Content at pl-[30px].
  // Trade dots: 13px → left edge at 12-6.5=5.5 → from content: -(30-5.5)=-24.5
  // Decision dots: 8px → left edge at 12-4=8 → from content: -(30-8)=-22

  return (
    <Card className="py-4 gap-0">
      <CardContent>
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-4">
          Execution Timeline
        </h3>

        <div className="relative pl-[30px]">
          {/* Vertical rail */}
          <div className="absolute top-0 bottom-0 w-px bg-border/40" style={{ left: '12px' }} />

          {entries.map((entry, i) => {
            const isLast = i === entries.length - 1;
            const prev = i > 0 ? entries[i - 1] : null;

            // Detect phase break: decision after a trade event, or new message group
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

              return (
                <div key={ev.id} className={cn('relative', i > 0 && 'mt-1.5', !isLast && 'pb-1.5')}>
                  {/* 13px dot — trade events are primary anchors */}
                  <div
                    className={cn('absolute w-[13px] h-[13px] rounded-full ring-2 ring-background', DOT[ev.action] ?? 'bg-muted-foreground/40')}
                    style={{ left: '-24.5px', top: '2px' }}
                  />
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className="text-[13px] font-bold text-foreground tracking-tight">
                      {ACTION_LABEL[ev.action] ?? ev.action}
                    </span>
                    <span className="text-[13px] font-semibold text-foreground/90 tabular-nums">
                      {ev.action === 'TRIM' && '\u2212'}{ev.action === 'ADD' && '+'}{ev.quantity} @ {formatCurrency(price)}
                    </span>
                    {trimPnl != null && (
                      <span className={cn('text-xs font-semibold tabular-nums', trimPnl > 0 ? 'text-profit' : 'text-loss')}>
                        {formatCurrency(trimPnl)}
                      </span>
                    )}
                    <span className="text-[11px] text-muted-foreground/60 tabular-nums ml-auto shrink-0">
                      {formatDate(ev.timestamp)}
                    </span>
                  </div>
                </div>
              );
            }

            // ─── Decision entry ──────────────────────
            const d = entry.data;
            const event = d.event ?? 'SETTLED';
            const isFail = d.outcome === 'FAIL' || event === 'QUOTE_FAILED';
            const isSkip = d.outcome === 'SKIP' || (d.snapshot as Record<string, unknown> | null)?.outcome === 'SKIP';

            return (
              <div key={d.id} className={cn(
                'relative',
                isPhaseBreak && 'mt-4 pt-3 before:absolute before:left-[-30px] before:right-0 before:top-0 before:h-px before:bg-border/50',
                !isPhaseBreak && i > 0 && 'mt-0',
                !isLast && 'pb-2.5',
              )}>
                {/* 8px dot — decisions are supporting context */}
                <div
                  className={cn('absolute w-[8px] h-[8px] rounded-full ring-2 ring-background', DOT[event] ?? 'bg-muted-foreground/30')}
                  style={{ left: '-22px', top: '5px' }}
                />

                {/* Header: event label + outcome + metrics */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={cn(
                    'text-[10px] font-bold uppercase tracking-wider shrink-0',
                    isFail ? 'text-loss/80' : 'text-foreground/60',
                  )}>
                    {EVENT_LABEL[event] ?? event}
                  </span>

                  {d.outcome && <Badge label={d.outcome} />}
                  {d.signalIndex != null && d.signalIndex > 0 && (
                    <span className="text-[10px] text-muted-foreground/50 tabular-nums">#{d.signalIndex}</span>
                  )}

                  <div className="flex items-center gap-1.5 ml-auto shrink-0">
                    {d.pnl != null && parseFloat(d.pnl) !== 0 && (
                      <span className={cn('text-xs font-semibold tabular-nums', pnlColor(d.pnl))}>{formatCurrency(d.pnl)}</span>
                    )}
                    {d.inputTokens != null && d.outputTokens != null && (
                      <span className="text-[10px] text-muted-foreground/50 tabular-nums">{d.inputTokens.toLocaleString()}/{d.outputTokens.toLocaleString()}</span>
                    )}
                    {/* Only show duration if meaningful (> 10ms) */}
                    {d.durationMs != null && d.durationMs > 10 && (
                      <span className="text-[10px] text-muted-foreground/50 tabular-nums">{fmtMs(d.durationMs)}</span>
                    )}
                  </div>
                </div>

                {/* Structured detail (badges, chips, prices) */}
                <div className="mt-0.5">
                  <DecisionDetail d={d} />
                </div>

                {/* Reasoning on its own line — not crammed with badges */}
                {d.reasoning && (
                  <p className={cn(
                    'text-[11px] mt-1 leading-relaxed line-clamp-2',
                    isFail ? 'text-loss/60' : isSkip ? 'text-muted-foreground/50' : 'text-foreground/60',
                  )}>
                    {d.reasoning}
                  </p>
                )}

                {/* Message quote for PARSED events */}
                {event === 'PARSED' && d.messageId && msgMap.has(d.messageId) && (() => {
                  const msg = msgMap.get(d.messageId)!;
                  return (
                    <p className="mt-1.5 text-[11px] text-foreground/50 italic line-clamp-2 border-l-2 border-foreground/20 pl-2">
                      {msg.cleanText}
                    </p>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
