'use client';

import { Badge } from './badge';
import { cn } from '@/lib/utils';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { safeParseFloat } from '../../../src/lib/numbers';
import type { RunDecision, TradeEvent } from '../../../src/db/schema';

// ─── Utilities ───────────────────────────────────────

function fmtMs(ms: number) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }

// ─── Decision Popover ────────────────────────────────

const PATH_LABEL: Record<string, string> = {
  orchestrator: 'Agent', deterministic: 'Deterministic',
  skipped: 'Hard Skip', pipeline_failure: 'Pipeline Fail',
};

function DecisionPopover({ d }: { d: RunDecision }) {
  const hasContent = d.outcome || d.reasoning || d.skipCategory || d.phase;
  return (
    <PopoverContent align="start" side="right" className="w-96 max-h-[420px] overflow-auto p-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
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
        {/* Reasoning */}
        {d.reasoning && (
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
          <span>id {d.id.slice(0, 8)}</span>
        </div>
      </div>
    </PopoverContent>
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

// ─── Legacy field access ─────────────────────────────
// The DB still has `event` and `signalIndex` columns from the old emitter,
// but they were removed from the Drizzle schema. Access via runtime cast.
type DecisionWithLegacy = RunDecision & { event?: string; signalIndex?: number };
function asLegacy(d: RunDecision): DecisionWithLegacy { return d as DecisionWithLegacy; }

// ─── Deduplication ───────────────────────────────────

/** Merge multiple run_decision rows per messageId into one best row. */
function deduplicateDecisions(decisions: RunDecision[]): RunDecision[] {
  const groups = new Map<string, RunDecision[]>();
  const noMsg: RunDecision[] = [];

  for (const d of decisions) {
    if (!d.messageId) { noMsg.push(d); continue; }
    const list = groups.get(d.messageId) ?? [];
    list.push(d);
    groups.set(d.messageId, list);
  }

  const result: RunDecision[] = [...noMsg];

  for (const rows of groups.values()) {
    if (rows.length === 1) { result.push(rows[0]); continue; }

    // Primary = the row with phase + outcome (the final summary row)
    const primary = rows.find(r => r.phase && r.outcome) ?? rows[0];
    const merged = { ...primary };

    // Fill in fields from sibling rows
    for (const row of rows) {
      if (!merged.reasoning && row.reasoning) merged.reasoning = row.reasoning;
      if (merged.inputTokens == null && row.inputTokens != null) merged.inputTokens = row.inputTokens;
      if (merged.outputTokens == null && row.outputTokens != null) merged.outputTokens = row.outputTokens;
      if (!merged.tradeId && row.tradeId) merged.tradeId = row.tradeId;
      if (!merged.skipCategory && row.skipCategory) merged.skipCategory = row.skipCategory;
      if (!merged.pnl && row.pnl) merged.pnl = row.pnl;
    }

    result.push(merged);
  }

  return result;
}

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
  const deduped = deduplicateDecisions(decisions);

  const eventOrder: Record<string, number> = {
    PARSED: 0, SIGNAL_RESOLVED: 1, SIZED: 2, ORDER_PLACED: 3,
    ORDER_ADJUSTED: 4, ORDER_FILLED: 5, SETTLED: 6,
    QUOTE_FAILED: 4, RETRY_LLM: 4,
  };

  const entries: Entry[] = [];

  for (const d of deduped) {
    const dl = asLegacy(d);
    const msg = d.messageId ? msgMap.get(d.messageId) : null;
    const event = dl.event ?? 'SETTLED';

    // Hide SETTLED FAIL when trade events prove the order actually filled
    if (event === 'SETTLED' && d.outcome === 'FAIL' && tradeActionSet.has('OPEN')) continue;

    // Hide entries with no visible content (empty shell rows from transitional emitter).
    const dec = d.outcome as string | null;
    const hasVisibleData = dec || d.reasoning || d.skipCategory || d.pnl || d.inputTokens != null;
    if (event === 'SETTLED' && !hasVisibleData) continue;

    const baseTs = msg?.timestamp ?? d.createdAt ?? '';
    const order = eventOrder[event] ?? 5;
    const sortKey = `${baseTs}|0|${String(order).padStart(2, '0')}|${dl.signalIndex ?? 0}`;
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
            const event = asLegacy(d).event ?? 'SETTLED';
            const isFail = d.outcome === 'FAIL';
            const isSkip = d.outcome === 'SKIP';

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

                  {/* Header: event label (popover trigger) + outcome + metrics */}
                  <div className="flex items-center gap-1.5 min-w-0">
                    <PopoverTrigger asChild>
                      <button type="button" className={cn(
                        'text-[10px] font-bold uppercase tracking-wider shrink-0 hover:underline underline-offset-2 cursor-pointer',
                        isFail ? 'text-loss/80' : 'text-foreground/60',
                      )}>
                        {EVENT_LABEL[event] ?? event}
                      </button>
                    </PopoverTrigger>

                    {d.outcome && <Badge label={d.outcome} />}
                    {d.skipCategory && (
                      <span className="text-[10px] text-muted-foreground/60 truncate max-w-[180px]">{d.skipCategory}</span>
                    )}

                    <div className="flex items-center gap-1.5 ml-auto shrink-0">
                      {d.pnl != null && parseFloat(d.pnl) !== 0 && (
                        <span className={cn('text-xs font-semibold tabular-nums', pnlColor(d.pnl))}>{formatCurrency(d.pnl)}</span>
                      )}
                      {d.inputTokens != null && d.outputTokens != null && (
                        <span className="text-[10px] text-muted-foreground/50 tabular-nums">{d.inputTokens.toLocaleString()}/{d.outputTokens.toLocaleString()}</span>
                      )}
                      {d.durationMs != null && d.durationMs > 10 && (
                        <span className="text-[10px] text-muted-foreground/50 tabular-nums">{fmtMs(d.durationMs)}</span>
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

                  {/* Message quote for PARSED events */}
                  {event === 'PARSED' && d.messageId && msgMap.has(d.messageId) && (() => {
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
