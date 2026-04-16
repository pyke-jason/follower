import { cn } from '@/lib/utils';
import { fmtMs } from '@/components/decision-shared';
import type { RunDecision } from '@src/db/schema';

// ─── Types ───────────────────────────────────────────

type SpanCategory = 'sync' | 'db' | 'broker' | 'llm' | 'market_data';

type Span = {
  name: string;
  category: SpanCategory;
  startMs: number;
  durationMs: number;
  children: Span[];
};

// ─── Constants ───────────────────────────────────────

const CAT_ORDER: SpanCategory[] = ['sync', 'db', 'market_data', 'broker', 'llm'];

const CAT_LABEL: Record<SpanCategory, string> = {
  sync: 'Sync', db: 'DB', broker: 'Broker', llm: 'LLM', market_data: 'Mkt Data',
};

const CAT_BAR: Record<SpanCategory, string> = {
  sync: 'bg-slate-400/40',
  db: 'bg-amber-400/50',
  broker: 'bg-sky-400/50',
  llm: 'bg-violet-400/60',
  market_data: 'bg-emerald-400/50',
};

const CAT_DOT: Record<SpanCategory, string> = {
  sync: 'bg-slate-400', db: 'bg-amber-400', broker: 'bg-sky-400',
  llm: 'bg-violet-400', market_data: 'bg-emerald-400',
};

const SPAN_LABEL: Record<string, string> = {
  orchestrator: 'orchestrator', execute: 'execute', parse: 'parse',
  openPath: 'open path', positionPath: 'position path', addPath: 'add path',
  llmPath: 'llm path', strangle: 'strangle', strangleExit: 'strangle exit',
  emitEvents: 'emit events', getMidpoint: 'midpoint', sizer: 'sizer',
  riskCheck: 'risk check', creditCheck: 'credit check', placeOrder: 'place order',
};

// ─── Span Helpers ────────────────────────────────────

function maxEnd(spans: Span[]): number {
  return spans.reduce((max, s) => {
    const end = s.startMs + s.durationMs;
    const childMax = s.children.length > 0 ? maxEnd(s.children) : 0;
    return Math.max(max, end, childMax);
  }, 0);
}

/** Aggregate self-time (duration minus children) by category. */
function aggregateByCategory(spans: Span[]): Record<SpanCategory, number> {
  const totals: Record<SpanCategory, number> = {
    sync: 0, db: 0, broker: 0, llm: 0, market_data: 0,
  };
  function walk(span: Span) {
    const childDuration = span.children.reduce((sum, c) => sum + c.durationMs, 0);
    totals[span.category] += Math.max(0, span.durationMs - childDuration);
    span.children.forEach(walk);
  }
  spans.forEach(walk);
  return totals;
}

/** Collect leaf spans (no children) for "slowest ops" display. */
function collectLeafSpans(spans: Span[]): Span[] {
  const leaves: Span[] = [];
  function walk(span: Span) {
    if (span.children.length === 0) leaves.push(span);
    else span.children.forEach(walk);
  }
  spans.forEach(walk);
  return leaves;
}

// ─── Component ───────────────────────────────────────

export function ExecutionTrace({ decisions }: { decisions: RunDecision[] }) {
  const traceDecision = decisions.find(d => d.event === 'TRACE');
  if (!traceDecision) return null;

  const snapshot = traceDecision.snapshot as Record<string, unknown> | null;
  if (!snapshot?.spans || !Array.isArray(snapshot.spans)) return null;

  const spans = snapshot.spans as Span[];
  const totalMs = maxEnd(spans);
  if (totalMs <= 0) return null;

  const breakdown = aggregateByCategory(spans);
  const activeCategories = CAT_ORDER.filter(cat => breakdown[cat] > 0);

  // Top slowest leaf spans (>10% of total time)
  const slowSpans = collectLeafSpans(spans)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3)
    .filter(s => s.durationMs > totalMs * 0.1);

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Performance
        </span>
        <span className="text-xs font-mono font-semibold tabular-nums text-foreground">
          {fmtMs(totalMs)}
        </span>
      </div>

      {/* Category breakdown bar */}
      <div className="flex h-2 rounded-full overflow-hidden gap-px">
        {activeCategories.map(cat => {
          const pct = (breakdown[cat] / totalMs) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={cat}
              className={cn('h-full', CAT_BAR[cat])}
              style={{ width: `${pct}%` }}
              title={`${CAT_LABEL[cat]}: ${fmtMs(breakdown[cat])} (${Math.round(pct)}%)`}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {activeCategories.map(cat => {
          const pct = Math.round((breakdown[cat] / totalMs) * 100);
          if (pct < 1) return null;
          return (
            <div key={cat} className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
              <div className={cn('h-1.5 w-1.5 rounded-full', CAT_DOT[cat])} />
              <span>{CAT_LABEL[cat]}</span>
              <span className="tabular-nums font-mono">{fmtMs(breakdown[cat])}</span>
            </div>
          );
        })}
      </div>

      {/* Slowest operations */}
      {slowSpans.length > 0 && (
        <div className="space-y-0.5 pt-0.5">
          <span className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">Hotspots</span>
          {slowSpans.map((span, i) => (
            <div key={i} className="flex items-center justify-between text-[10px] font-mono">
              <div className="flex items-center gap-1.5 text-muted-foreground/50">
                <div className={cn('h-1 w-1 rounded-full', CAT_DOT[span.category])} />
                <span>{SPAN_LABEL[span.name] ?? span.name}</span>
              </div>
              <span className="tabular-nums text-muted-foreground/40">
                {fmtMs(span.durationMs)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
