import type { ReactNode } from 'react';
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
  backHref?: string | null;
  actions?: ReactNode;
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {backHref && (
          <Link to={backHref} className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        )}
        <span className="text-muted-foreground">{hasTrade ? 'Trade' : 'Task'}</span>
        <span className="text-muted-foreground/40">/</span>
        <span className="font-mono text-xs text-muted-foreground/60">
          {(trade?.id ?? task?.id ?? '').slice(0, 8)}
        </span>
        {trader && <span className="text-xs text-muted-foreground/70">{trader}</span>}
        {actions && <div className="ml-auto">{actions}</div>}
      </div>

      <Card className="relative gap-0 overflow-hidden rounded-[30px] border-border/70 bg-gradient-to-br from-card via-card to-muted/30 py-0 shadow-sm">
        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-r from-emerald-500/12 via-transparent to-amber-500/12" />

        <div className="relative space-y-6 px-5 py-5 md:px-6 md:py-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold tracking-[0.22em]', meta.tone, OUTCOME_PILL)}>
                  <Icon className={cn('h-3.5 w-3.5', spinning && 'animate-spin')} />
                  {meta.label}
                </div>
                {direction && <Badge label={direction} />}
                {strategy && <Badge label={strategy} />}
                {flags.map((f) => (
                  <span
                    key={f}
                    className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-warning"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    {f}
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                <h1 className="text-4xl font-semibold tracking-[-0.04em] text-foreground">
                  {symbol ?? <span className="text-muted-foreground/60">—</span>}
                </h1>
                {strategy && (
                  <span className="pb-1 text-sm font-medium text-muted-foreground">
                    {hasTrade ? 'Live position detail' : 'Signal inspection'}
                  </span>
                )}
              </div>

              {legSummary && strategy !== 'STOCK' && (
                <p className="text-sm text-muted-foreground tabular-nums font-mono">{legSummary}</p>
              )}

              {reason && (
                <p className="max-w-3xl text-sm leading-relaxed text-foreground/80">
                  {reason}
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:w-[360px]">
              <HeroMetaCard label="Trader">
                <span className="text-sm font-semibold">{trader ?? '—'}</span>
              </HeroMetaCard>
              <HeroMetaCard label={hasTrade ? (isOpen ? 'Opened' : 'Closed') : 'Decision'}>
                <span className="text-sm font-semibold tabular-nums">
                  {formatDate((isOpen ? startTs : endTs) ?? startTs)}
                </span>
              </HeroMetaCard>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
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
            <div className="flex flex-wrap items-center gap-4 border-t border-border/50 pt-4 text-[11px] text-muted-foreground tabular-nums">
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

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/80 px-4 py-3 shadow-sm shadow-black/[0.03]">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function HeroMetaCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/75 px-4 py-3 shadow-sm shadow-black/[0.03]">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Dash() {
  return <span className="text-base font-semibold tabular-nums text-muted-foreground/30">—</span>;
}

const OUTCOME_PILL = 'border-current/15 bg-background/80 shadow-sm shadow-black/[0.04]';

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
