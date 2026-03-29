import { cn } from '@/lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { Popover, PopoverTrigger } from '@/components/ui/popover';
import { DecisionPopover } from './decision-timeline';
import { fmtMs, EVENT_LABEL, DOT } from '@/components/decision-shared';
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

type EventMarker = {
  event: string;
  durationMs: number;
  decision: RunDecision;
};

type Props = {
  spans: Span[];
  markers: EventMarker[];
  totalMs: number;
  compact?: boolean;
};

// ─── Schematic Design Tokens ─────────────────────────

const ROW_H = 22; // Ultra-slim
const ROW_GAP = 6;
const BAR_RADIUS = '2px'; // Micro-radius for geometry
const MIN_BAR_PCT = 0.5;

// The Schematic Palette: (Vapor BG, Etched Wireframe, Core Text)
const CAT_STYLE: Record<SpanCategory, { bg: string; edge: string; text: string; label: string }> = {
  sync: { bg: 'rgba(148, 163, 184, 0.04)', edge: 'rgba(148, 163, 184, 0.3)', text: '#94a3b8', label: 'SYN' },
  db: { bg: 'rgba(245, 158, 11, 0.04)', edge: 'rgba(245, 158, 11, 0.3)', text: '#fbbf24', label: 'DB' },
  broker: { bg: 'rgba(56, 189, 248, 0.04)', edge: 'rgba(56, 189, 248, 0.3)', text: '#38bdf8', label: 'BKR' },
  llm: { bg: 'rgba(167, 139, 250, 0.04)', edge: 'rgba(167, 139, 250, 0.3)', text: '#a78bfa', label: 'LLM' },
  market_data: { bg: 'rgba(52, 211, 153, 0.04)', edge: 'rgba(52, 211, 153, 0.3)', text: '#34d399', label: 'MKT' },
};

const SPAN_LABEL: Record<string, string> = {
  orchestrator: 'ORCHESTRATOR',
  execute: 'EXECUTE',
  parse: 'PARSE',
  openPath: 'PATH:OPEN',
  positionPath: 'PATH:POS',
  addPath: 'PATH:ADD',
  llmPath: 'PATH:LLM',
  strangle: 'STRANGLE',
  strangleExit: 'STRANGLE:EXIT',
  emitEvents: 'EVENTS:EMIT',
  getMidpoint: 'MIDPOINT:GET',
  sizer: 'SIZE:POS',
  riskCheck: 'RISK:CHK',
  creditCheck: 'CREDIT:CHK',
  placeOrder: 'ORDER:PLACE',
};

// ─── Helpers ────────────────────────────────────────

function flattenSpans(spans: Span[], depth = 0): { span: Span; depth: number }[] {
  const result: { span: Span; depth: number }[] = [];
  for (const span of spans) {
    result.push({ span, depth });
    if (span.children.length > 0) {
      result.push(...flattenSpans(span.children, depth + 1));
    }
  }
  return result;
}

function maxEnd(spans: Span[]): number {
  return spans.reduce((max, s) => {
    const end = s.startMs + s.durationMs;
    const childMax = s.children.length > 0 ? maxEnd(s.children) : 0;
    return Math.max(max, end, childMax);
  }, 0);
}

// ─── Data Extraction ────────────────────────────────

export function extractFlamegraphData(decisions: RunDecision[]): { spans: Span[]; markers: EventMarker[]; totalMs: number } | null {
  const traceDecision = decisions.find(d => d.event === 'TRACE');
  if (!traceDecision) return null;
  const snapshot = traceDecision.snapshot as Record<string, unknown> | null;
  if (!snapshot?.spans || !Array.isArray(snapshot.spans)) return null;

  const spans = snapshot.spans as Span[];

  const markers: EventMarker[] = decisions
    .filter(d => d.event !== 'TRACE' && d.durationMs != null)
    .map(d => ({ event: d.event ?? 'SETTLED', durationMs: d.durationMs!, decision: d }));

  const totalMs = maxEnd(spans);
  if (totalMs <= 0) return null;

  return { spans, markers, totalMs };
}

// ─── Component ──────────────────────────────────────

export function ExecutionFlamegraph({ spans, markers, totalMs, compact }: Props) {
  const flat = flattenSpans(spans);
  const maxDepth = flat.reduce((max, f) => Math.max(max, f.depth), 0);
  const spanAreaHeight = (maxDepth + 1) * (ROW_H + ROW_GAP);
  const markerRowHeight = 20;
  const containerHeight = spanAreaHeight + markerRowHeight;

  return (
    <TooltipProvider delayDuration={0}>
      <div className={cn('select-none flex flex-col font-mono antialiased', compact ? 'gap-3' : 'gap-5')}>
        
        {/* HUD Header */}
        <div className="flex items-center gap-3 w-full px-1.5 border-l-2 border-border/20">
          <span className="text-[10px] font-medium tracking-[0.2em] text-muted-foreground/50 uppercase shrink-0">
            SCHEMATIC.TRACE
          </span>
          <div className="flex-1 h-px bg-border/20" />
          <span className="text-[11px] tracking-tight text-white/90 shrink-0 font-semibold">
            {fmtMs(totalMs)}
          </span>
        </div>

        {/* The Grid Canvas */}
        <div 
          className="relative w-full rounded-sm overflow-hidden" 
          style={{ 
            height: containerHeight,
            background: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.03) 1px, transparent 0)',
            backgroundSize: '16px 16px', // DOT GRID DEFINES THE SPACE
            border: '1px solid rgba(255,255,255,0.02)'
          }}
        >
          
          {/* Subtle Vertical Time Demarcations */}
          <div className="absolute inset-y-0 w-full flex justify-between pointer-events-none z-0">
            {[0, 25, 50, 75, 100].map(pct => (
              <div key={pct} className="h-full w-px bg-white/5" />
            ))}
          </div>

          {/* Span Wireframes */}
          {flat.map(({ span, depth }, i) => {
            const leftPct = (span.startMs / totalMs) * 100;
            const rawWidthPct = (span.durationMs / totalMs) * 100;
            const widthPct = Math.max(MIN_BAR_PCT, rawWidthPct);
            const style = CAT_STYLE[span.category] ?? CAT_STYLE.sync;
            const label = SPAN_LABEL[span.name] ?? span.name;
            const showInlineLabel = widthPct > 12;

            return (
              <Tooltip key={i}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center overflow-hidden cursor-crosshair transition-all duration-300 hover:z-10 group"
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      top: depth * (ROW_H + ROW_GAP),
                      height: ROW_H,
                      backgroundColor: style.bg,
                      border: `1px solid ${style.edge}`,
                      borderRadius: BAR_RADIUS,
                      color: style.text,
                    }}
                  >
                    {showInlineLabel && (
                      <span className="truncate pl-2 text-[9px] font-medium tracking-[0.1em] text-white/90 uppercase drop-shadow-[0_0_2px_rgba(255,255,255,0.4)]">
                        {label}
                      </span>
                    )}
                    <span className="ml-auto pr-1.5 text-[9px] opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        {fmtMs(span.durationMs)}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="px-2.5 py-1.5 bg-black border border-white/10 shadow-xl rounded-sm">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-bold text-white tracking-wide uppercase">{label}</span>
                    <span className="text-[10px] text-white/50">{fmtMs(span.durationMs)} • {style.label}</span>
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}

          {/* Pulse Markers / Vertical Razor Cuts */}
          {markers.map((marker, i) => {
            const leftPct = (marker.durationMs / totalMs) * 100;
            const dotClass = DOT[marker.event] ?? 'bg-slate-400';
            const label = EVENT_LABEL[marker.event] ?? marker.event;

            return (
              <Popover key={i}>
                <Tooltip>
                  <PopoverTrigger asChild>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="absolute group pointer-events-auto outline-none transition-all duration-300"
                        style={{
                          left: `${leftPct}%`,
                          top: 0,
                          width: '1px',
                          height: spanAreaHeight, // FULL HEIGHT RAZOR CUT
                          backgroundColor: 'rgba(255,255,255,0.06)', // THE MARKER LINE
                        }}
                      >
                        {/* Hover razor line (glowing) */}
                        <div className="absolute inset-y-0 left-0 w-[1px] bg-white opacity-0 group-hover:opacity-100 transition-opacity blur-[1px]" />
                        
                        {/* The Pulse Node (positioned at the bottom axis) */}
                        <div className={cn(
                          'absolute w-1.5 h-1.5 rounded-full ring-2 ring-background z-20 transition-all duration-200 group-hover:scale-125 group-hover:ring-white/20',
                          dotClass,
                        )} 
                        style={{ 
                            bottom: `-${markerRowHeight / 2}px`, 
                            left: '-2.5px', // Center the dot
                            boxShadow: `0 0 8px ${dotClass}` 
                        }} 
                        />
                      </button>
                    </TooltipTrigger>
                  </PopoverTrigger>
                  
                  <TooltipContent side="bottom" className="px-2 py-1 bg-black border border-white/10 rounded-sm">
                    <span className="text-[9px] font-semibold text-white tracking-widest uppercase pr-1">{label}</span>
                    <span className="text-[9px] text-white/40">{fmtMs(marker.durationMs)}</span>
                  </TooltipContent>
                </Tooltip>
                <DecisionPopover d={marker.decision} />
              </Popover>
            );
          })}
          
          {/* Axis Line */}
          <div className="absolute inset-x-0 h-px bg-white/10 z-10" style={{ bottom: `${markerRowHeight / 2}px` }} />

        </div>

        {/* HUD Legend */}
        {!compact && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pt-2 px-1.5 border-l-2 border-border/20">
            {(Object.keys(CAT_STYLE) as SpanCategory[]).map((cat) => (
              <div key={cat} className="flex items-center gap-1.5 transition-opacity hover:opacity-80 cursor-default">
                <div
                  className="w-1.5 h-1.5 rounded-sm"
                  style={{ 
                    backgroundColor: CAT_STYLE[cat].bg,
                    border: `1px solid ${CAT_STYLE[cat].edge}`,
                    boxShadow: `0 0 4px ${CAT_STYLE[cat].edge}`
                  }}
                />
                <span className="text-[9px] font-medium text-white/50 tracking-widest uppercase">{CAT_STYLE[cat].label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}