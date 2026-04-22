import { Link } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, CircleCheck, CircleX, SkipForward, Loader2, CircleAlert } from 'lucide-react';
import { Badge } from '@/components/badge';
import { Card } from '@/components/ui/card';
import { formatCurrency, formatDate, pnlColor, relativeTime } from '@/lib/format';
import { formatLegsSummary, contractMultiplier, tradeQty } from '@src/lib/trade';
import { safeParseFloat } from '@src/lib/numbers';
import { cn } from '@/lib/utils';
import type { Trade, Task, RunDecision } from '@src/db/schema';
import type { LivePosition } from '@/stores/trades-store';

type OutcomeKind = 'OPEN' | 'CLOSED' | 'SKIP' | 'FAIL' | 'MANUAL_REVIEW' | 'PENDING';

const OUTCOME_META: Record<OutcomeKind, { label: string; icon: typeof CircleCheck; tone: string }> = {
  OPEN:          { label: 'OPEN',          icon: CircleCheck, tone: 'text-profit' },
  CLOSED:        { label: 'CLOSED',        icon: CircleCheck, tone: 'text-muted-foreground' },
  SKIP:          { label: 'SKIPPED',       icon: SkipForward, tone: 'text-muted-foreground' },
  FAIL:          { label: 'FAILED',        icon: CircleX,     tone: 'text-loss' },
  MANUAL_REVIEW: { label: 'MANUAL REVIEW', icon: CircleAlert, tone: 'text-warning' },
  PENDING:       { label: 'PENDING',       icon: Loader2,     tone: 'text-warning' },
};

export function PositionHero({ trade, task, decision, livePosition, backHref, actions }: {
  trade: Trade | null;
  task: Task | null;
  decision: RunDecision | null;
  livePosition: LivePosition | null;
  backHref: string;
  actions?: React.ReactNode;
}) {
  const outcome = resolveOutcome(trade, task, decision);
  const meta = OUTCOME_META[outcome];
  const Icon = meta.icon;
  const spinning = outcome === 'PENDING';

  // Identity — from trade if present, else from task.context parsing snapshot
  const symbol = trade?.symbol ?? (task?.context?.symbols?.[0] ?? null);
  const direction = trade?.direction ?? task?.context?.directionHint ?? null;
  const strategy = trade?.strategy ?? task?.context?.detectedStrategies?.[0]?.strategy ?? null;
  const trader = trade?.trader ?? task?.context?.author ?? null;

  const flags = trade?.metadata.flags ?? [];
  const legSummary = trade ? formatLegsSummary(trade.legs, trade.strategy) : null;

  // Position data (null when no trade)
  const hasTrade = trade != null;
  const entry = trade ? (safeParseFloat(trade.avgEntryPrice) || safeParseFloat(trade.entryPrice)) : null;
  const exit = trade ? safeParseFloat(trade.exitPrice) : null;
  const qty = trade ? tradeQty(trade.quantity) : null;
  const mult = trade ? contractMultiplier(trade.strategy) : 1;
  const costBasis = entry && qty ? entry * qty * mult : null;
  const isOpen = trade?.status === 'OPEN';
  const livePnl = isOpen ? livePosition?.unrealizedPnl ?? null : null;
  const realizedPnl = trade ? safeParseFloat(trade.pnl) : null;
  const pnl = livePnl ?? (trade && !isOpen ? realizedPnl : null);
  const pnlPct = pnl != null && costBasis ? (pnl / Math.abs(costBasis)) * 100 : null;
  const markPrice = livePosition?.marketValue != null && qty
    ? livePosition.marketValue / (qty * mult)
    : null;

  // When + how long.
  // Trade: duration from openedAt → (closedAt if closed, else now).
  // No trade: show when the decision happened (task completedAt), not a
  // "held for" window — a skipped/failed signal was never held.
  const startTs = trade?.openedAt ?? task?.createdAt ?? null;
  const endTs = trade
    ? (isOpen ? null : trade.closedAt)
    : (task?.completedAt ?? null);
  const durationLabel = hasTrade ? holdingDuration(startTs, endTs) : null;
  const whenLabel = !hasTrade && endTs ? relativeTime(endTs) : null;

  // Reason — shown under the hero title for non-trade cases
  const reason = !hasTrade ? decision?.reasoning ?? null : null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 text-sm">
        <Link to={backHref} className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="text-muted-foreground">{hasTrade ? 'Trade' : 'Task'}</span>
        <span className="text-muted-foreground/40">/</span>
        <span className="font-mono text-xs text-muted-foreground/60">
          {(trade?.id ?? task?.id ?? '').slice(0, 8)}
        </span>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>

      <Card className="py-0 gap-0">
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight">
              {symbol ?? <span className="text-muted-foreground/60">—</span>}
            </h1>
            {direction && <Badge label={direction} />}
            {strategy && <Badge label={strategy} />}
            <div className={cn('inline-flex items-center gap-1.5 text-sm font-semibold', meta.tone)}>
              <Icon className={cn('h-4 w-4', spinning && 'animate-spin')} />
              {meta.label}
            </div>
            {flags.map((f) => (
              <span
                key={f}
                className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-warning bg-warning/10 border border-warning/20 rounded px-1.5 py-0.5"
              >
                <AlertTriangle className="h-3 w-3" />
                {f}
              </span>
            ))}
            {trader && <span className="text-xs text-muted-foreground ml-auto">{trader}</span>}
          </div>

          {legSummary && strategy !== 'STOCK' && (
            <p className="text-sm text-muted-foreground tabular-nums font-mono">{legSummary}</p>
          )}

          {reason && (
            <p className="text-sm text-foreground/80 leading-relaxed">
              {reason}
            </p>
          )}

          <div className="grid grid-cols-2 md:grid-cols-5 gap-x-6 gap-y-3 pt-1">
            <Metric label="Qty">
              {qty != null
                ? <span className="text-base font-semibold tabular-nums">{qty}</span>
                : <Dash />}
            </Metric>

            <Metric label="Avg Entry">
              {entry
                ? <span className="text-base font-semibold tabular-nums font-mono">{formatCurrency(entry)}</span>
                : <Dash />}
            </Metric>

            <Metric label={isOpen ? 'Mark' : hasTrade ? 'Exit' : 'Mark'}>
              {(isOpen ? markPrice : exit)
                ? <span className="text-base font-semibold tabular-nums font-mono">
                    {formatCurrency(isOpen ? markPrice : exit)}
                  </span>
                : <Dash />}
            </Metric>

            <Metric label={isOpen ? 'Unrealized P&L' : hasTrade ? 'Realized P&L' : 'P&L'}>
              {pnl != null ? (
                <div className={cn('text-xl font-bold tabular-nums font-mono', pnlColor(pnl))}>
                  {formatCurrency(pnl)}
                  {pnlPct != null && (
                    <span className="ml-2 text-xs font-semibold">
                      {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%
                    </span>
                  )}
                </div>
              ) : (
                <Dash />
              )}
              {isOpen && livePnl == null && (
                <p className="text-[10px] text-muted-foreground/60 mt-0.5">broker data unavailable</p>
              )}
            </Metric>

            <Metric label={isOpen ? 'Open for' : hasTrade ? 'Held' : 'When'}>
              {durationLabel ? (
                <>
                  <span className="text-base font-semibold tabular-nums">{durationLabel}</span>
                  {startTs && (
                    <p className="text-[10px] text-muted-foreground/60 tabular-nums mt-0.5">
                      {formatDate(startTs)}
                      {endTs && ` → ${formatDate(endTs)}`}
                    </p>
                  )}
                </>
              ) : whenLabel ? (
                <>
                  <span className="text-base font-semibold tabular-nums">{whenLabel} ago</span>
                  {endTs && (
                    <p className="text-[10px] text-muted-foreground/60 tabular-nums mt-0.5">
                      {formatDate(endTs)}
                    </p>
                  )}
                </>
              ) : (
                <Dash />
              )}
            </Metric>
          </div>

          {costBasis != null && (
            <div className="pt-2 border-t border-border/40 flex items-center gap-4 text-[11px] text-muted-foreground tabular-nums">
              <span>Cost basis <span className="font-mono text-foreground/70">{formatCurrency(costBasis)}</span></span>
              {livePosition?.marketValue != null && (
                <span>Market value <span className="font-mono text-foreground/70">{formatCurrency(livePosition.marketValue)}</span></span>
              )}
              {trade?.realizedPnl && parseFloat(String(trade.realizedPnl)) !== 0 && (
                <span>
                  Realized from trims{' '}
                  <span className={cn('font-mono', pnlColor(trade.realizedPnl))}>
                    {formatCurrency(trade.realizedPnl)}
                  </span>
                </span>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">
        {label}
      </p>
      {children}
    </div>
  );
}

function Dash() {
  return <span className="text-base font-semibold tabular-nums text-muted-foreground/30">—</span>;
}

/** Derive the hero's outcome from the most authoritative source available. */
function resolveOutcome(trade: Trade | null, task: Task | null, decision: RunDecision | null): OutcomeKind {
  if (trade) {
    return trade.status === 'OPEN' ? 'OPEN' : 'CLOSED';
  }
  // No trade — rely on the SETTLED run_decision outcome, not task.status.
  const outcome = decision?.outcome;
  if (outcome === 'FAIL') return 'FAIL';
  if (outcome === 'SKIP') return 'SKIP';
  if (outcome === 'MANUAL_REVIEW') return 'MANUAL_REVIEW';
  // Fall back to task lifecycle state
  if (task?.status === 'PENDING' || task?.status === 'IN_PROGRESS') return 'PENDING';
  if (task?.status === 'FAILED') return 'FAIL';
  if (task?.status === 'SKIPPED') return 'SKIP';
  return 'PENDING';
}

function holdingDuration(startIso: string | null, endIso: string | null): string | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = end - start;
  if (ms < 0) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
