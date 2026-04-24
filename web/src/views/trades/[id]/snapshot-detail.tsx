import { Badge } from '@/components/badge';
import { StatItem } from '@/components/stat-item';
import { InfoChip } from '@/components/info-chip';
import { formatCurrency, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { getSnapshotParams, getCancelledOrder, getSnapshotSignal } from '@/lib/snapshot-accessors';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

type LegRow = {
  symbol?: string;
  strike?: number;
  expiry?: string;
  type?: string;
  action?: string;
  side?: string;
  quantity?: number;
};

// ─── ParseResultView — "What the system heard" ─────

const ROUTE_LABEL: Record<string, string> = {
  deterministic: 'Deterministic',
  orchestrator: 'Agent',
  hard_skip: 'Hard Skip',
};

export function ParseResultView({ data }: { data: Record<string, unknown> }) {
  const route = data.route != null ? String(data.route) : null;
  const routeLabel = route ? (ROUTE_LABEL[route] ?? route) : null;
  const isLotto = data.isLotto === true;
  const isStrangle = data.isStrangle === true;

  const strikes = Array.isArray(data.strikes) ? (data.strikes as number[]) : null;
  const expiryHint = data.expiryHint ?? data.expiry;
  const premiumHint = data.premiumHint ?? data.price;
  const exitPercent = data.exitPercent;
  const complexityFlags = Array.isArray(data.complexityFlags) ? (data.complexityFlags as string[]) : null;

  return (
    <div className="space-y-2 text-sm">
      {/* Route + flags */}
      {(routeLabel || isLotto || isStrangle) && (
        <div className="flex items-center gap-2 flex-wrap">
          {routeLabel && <Badge label={routeLabel} />}
          {isLotto && <span className="text-[10px] text-warning font-medium">LOTTO</span>}
          {isStrangle && <span className="text-[10px] text-strategy-pds font-medium">STRANGLE</span>}
        </div>
      )}

      {/* Identity row — compact inline badges */}
      <div className="flex items-center gap-2 flex-wrap">
        {data.action != null && <Badge label={String(data.action)} />}
        {data.symbol != null && <InfoChip label={String(data.symbol)} />}
        {data.strategy != null && <Badge label={String(data.strategy)} />}
        {data.direction != null && <Badge label={String(data.direction)} />}
      </div>

      {/* Extracted fields — only what exists */}
      {(strikes || expiryHint != null || premiumHint != null || exitPercent != null) && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {strikes && strikes.length > 0 && (
            <StatItem label="Strikes">
              <span className="text-foreground tabular-nums font-medium">
                {strikes.join(' / ')}
              </span>
            </StatItem>
          )}
          {expiryHint != null && (
            <StatItem label="Expiry Hint">
              <span className="text-foreground tabular-nums">{String(expiryHint)}</span>
            </StatItem>
          )}
          {premiumHint != null && (
            <StatItem label="Premium Hint">
              <span className="text-foreground tabular-nums">${String(premiumHint)}</span>
            </StatItem>
          )}
          {exitPercent != null && (
            <StatItem label="Exit %">
              <span className="text-foreground tabular-nums">
                {typeof exitPercent === 'number'
                  ? `${(exitPercent * 100).toFixed(0)}%`
                  : `${String(exitPercent)}%`}
              </span>
            </StatItem>
          )}
        </div>
      )}

      {/* Complexity flags */}
      {complexityFlags && complexityFlags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {complexityFlags.map((flag) => (
            <span
              key={flag}
              className="text-[10px] text-muted-foreground/60 border border-dashed border-muted-foreground/20 rounded px-1.5 py-0.5"
            >
              {flag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SignalView — "What we're trading" (legs table) ─

// NOTE: Inline table for 1-4 fixed rows (signal detail, not a data-driven list)
export function SignalView({ data }: { data: Record<string, unknown> }) {
  const legs = Array.isArray(data.legs) ? (data.legs as LegRow[]) : [];
  return (
    <div className="space-y-2">
      {data.orderType != null ? (
        <div className="flex items-center gap-2">
          <Badge label={String(data.orderType)} />
          {data.limitPrice != null ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              limit ${String(data.limitPrice)}
            </span>
          ) : null}
        </div>
      ) : null}
      {legs.length > 0 && (
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="text-muted-foreground">
              <TableHead className="h-7 pr-3 py-1">Symbol</TableHead>
              <TableHead className="h-7 pr-3 py-1">Strike</TableHead>
              <TableHead className="h-7 pr-3 py-1">Expiry</TableHead>
              <TableHead className="h-7 pr-3 py-1">Type</TableHead>
              <TableHead className="h-7 pr-3 py-1">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {legs.map((leg, i) => (
              <TableRow key={i} className="border-border/30">
                <TableCell className="pr-3 py-1 tabular-nums">{leg.symbol ?? '--'}</TableCell>
                <TableCell className="pr-3 py-1 tabular-nums">{leg.strike ?? '--'}</TableCell>
                <TableCell className="pr-3 py-1 tabular-nums">{leg.expiry ?? '--'}</TableCell>
                <TableCell className="pr-3 py-1">{leg.type ? <Badge label={leg.type} /> : '--'}</TableCell>
                <TableCell className="pr-3 py-1">{leg.action ?? leg.side ?? '--'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ─── SizedView — "How many contracts and why" ───────

export function SizedView({ data }: { data: Record<string, unknown> }) {
  const reasoning = data.reasoning != null ? String(data.reasoning) : null;
  const reasoningLines = reasoning ? reasoning.split('; ') : [];

  return (
    <div className="space-y-3 text-sm">
      {/* Headline: quantity + total risk */}
      <div className="flex items-baseline gap-4">
        {data.quantity != null && (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Quantity</p>
            <p className="text-2xl font-bold text-foreground tabular-nums">{String(data.quantity)}</p>
          </div>
        )}
        {data.riskPerTrade != null && (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Total Risk</p>
            <p className="text-lg font-semibold text-foreground tabular-nums">
              {formatCurrency(Number(data.riskPerTrade))}
            </p>
          </div>
        )}
      </div>

      {/* Market Mid */}
      {data.entryPrice != null && (
        <StatItem label="Market Mid">
          <span className="text-foreground tabular-nums">${String(data.entryPrice)}</span>
          <span className="text-[10px] text-muted-foreground/50 ml-1.5">(used for risk math)</span>
        </StatItem>
      )}

      {/* Reasoning — split on "; " for scannability */}
      {reasoningLines.length > 0 && (
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Reasoning</p>
          <div className="text-xs text-foreground/70 leading-relaxed space-y-0.5">
            {reasoningLines.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── OrderPlacedView — "What order was sent" ────────

export function OrderPlacedView({ data }: { data: Record<string, unknown> }) {
  const params = getSnapshotParams(data);
  const sigPrice = data.sigPrice != null ? Number(data.sigPrice) : null;
  const mid = data.mid != null ? Number(data.mid) : null;
  const limitPrice = params?.limitPrice != null ? Number(params.limitPrice) : null;
  const isCredit = data.isCredit;
  const hasPriceDecision = sigPrice != null && mid != null;

  return (
    <div className="space-y-3 text-sm">
      {/* Identity row: Order ID + Order Type + Credit/Debit */}
      <div className="flex items-center gap-2 flex-wrap">
        {data.orderId != null && (
          <span className="text-foreground tabular-nums font-mono text-xs">#{String(data.orderId)}</span>
        )}
        {params?.orderType != null && <Badge label={String(params.orderType)} />}
        {isCredit != null && (
          <Badge label={isCredit === true ? 'CREDIT' : 'DEBIT'} />
        )}
      </div>

      {/* Price Decision section */}
      {hasPriceDecision ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <StatItem label="Signal Price">
              <span className="text-foreground tabular-nums">{formatCurrency(sigPrice)}</span>
            </StatItem>
            <StatItem label="Market Mid">
              <span className="text-foreground tabular-nums">{formatCurrency(mid)}</span>
            </StatItem>
          </div>
          {limitPrice != null && (
            <StatItem label="Limit Price">
              <span className="text-foreground tabular-nums font-medium text-base">{formatCurrency(limitPrice)}</span>
            </StatItem>
          )}
          <p className="text-[10px] text-muted-foreground/60">
            {sigPrice === mid
              ? 'signal = market mid'
              : isCredit === true
                ? '\u2192 used better of signal vs mid'
                : '\u2192 used lower of signal vs mid'}
          </p>
        </div>
      ) : (
        /* Fallback for older data without sigPrice/mid */
        limitPrice != null && (
          <StatItem label="Limit Price">
            <span className="text-foreground tabular-nums font-medium">{formatCurrency(limitPrice)}</span>
          </StatItem>
        )
      )}
    </div>
  );
}

// ─── OrderFilledView — "How the fill went" ──────────

export function OrderFilledView({ data }: { data: Record<string, unknown> }) {
  const params = getSnapshotParams(data);
  const filledPrice = data.filledPrice != null ? Number(data.filledPrice) : null;
  const originalLimit = params?.limitPrice != null ? Number(params.limitPrice) : null;
  const adjustmentCount = data.adjustmentCount != null ? Number(data.adjustmentCount) : null;
  const immediatelyFilled = data.immediatelyFilled === true;
  const slippage = originalLimit != null && filledPrice != null
    ? Math.abs(filledPrice - originalLimit)
    : null;

  return (
    <div className="space-y-3 text-sm">
      {/* Slippage headline */}
      <p className={cn(
        'text-sm font-semibold',
        immediatelyFilled
          ? 'text-profit'
          : slippage == null || slippage === 0
            ? 'text-foreground'
            : 'text-warning',
      )}>
        {immediatelyFilled
          ? 'Filled immediately at limit'
          : slippage == null
            ? 'Filled'
            : slippage === 0
              ? 'Filled at limit'
              : `${formatCurrency(slippage)} slippage from limit${adjustmentCount != null && adjustmentCount > 0 ? ` (${adjustmentCount} chase${adjustmentCount === 1 ? '' : 's'})` : ''}`}
      </p>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {filledPrice != null && (
          <StatItem label="Fill Price">
            <span className="text-foreground tabular-nums font-medium">{formatCurrency(filledPrice)}</span>
          </StatItem>
        )}
        {originalLimit != null && (
          <StatItem label="Original Limit">
            <span className="text-foreground tabular-nums">{formatCurrency(originalLimit)}</span>
          </StatItem>
        )}
        {adjustmentCount != null && (
          <StatItem label="Chases">
            <span className="text-foreground tabular-nums">{adjustmentCount}</span>
          </StatItem>
        )}
        {data.commission != null && (
          <StatItem label="Commission">
            <span className="text-foreground tabular-nums">{formatCurrency(Number(data.commission))}</span>
          </StatItem>
        )}
        {data.fillTimestamp != null && (
          <StatItem label="Fill Time">
            <span className="text-foreground tabular-nums text-xs">{formatDate(String(data.fillTimestamp))}</span>
          </StatItem>
        )}
        {data.filledAt != null && data.fillTimestamp == null && (
          <StatItem label="Fill Time">
            <span className="text-foreground tabular-nums text-xs">{formatDate(String(data.filledAt))}</span>
          </StatItem>
        )}
      </div>

      {/* Order ID footer */}
      {data.orderId != null && (
        <p className="text-[10px] text-muted-foreground/50 tabular-nums font-mono">
          Order #{String(data.orderId)}
        </p>
      )}
    </div>
  );
}

// ─── OrderCancelledView — "Why the order failed" ────

export function OrderCancelledView({ data }: { data: Record<string, unknown> }) {
  // Snapshot shape is { order, pending } — order fields are nested
  const order = getCancelledOrder(data);
  const params = order?.params;
  const originalLimit = params?.limitPrice != null ? Number(params.limitPrice) : null;
  const finalLimit = order?.currentLimitPrice != null ? Number(order.currentLimitPrice) : null;
  const adjustmentCount = order?.adjustmentCount != null ? Number(order.adjustmentCount) : null;
  const status = order?.status != null ? String(order.status) : null;
  const limitsChanged = originalLimit != null && finalLimit != null && originalLimit !== finalLimit;

  return (
    <div className="space-y-2 text-sm">
      {/* Price journey */}
      {originalLimit != null && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-foreground tabular-nums">{formatCurrency(originalLimit)}</span>
          {limitsChanged && (
            <>
              <span className="text-muted-foreground/50">
                {adjustmentCount != null && adjustmentCount > 0
                  ? `\u2192 ${adjustmentCount} chase${adjustmentCount === 1 ? '' : 's'} \u2192`
                  : '\u2192'}
              </span>
              <span className="text-foreground tabular-nums">{formatCurrency(finalLimit)}</span>
            </>
          )}
          {!limitsChanged && adjustmentCount != null && adjustmentCount > 0 && (
            <span className="text-muted-foreground/50">({adjustmentCount} chase{adjustmentCount === 1 ? '' : 's'})</span>
          )}
        </div>
      )}

      {/* Reason / status */}
      {status != null && <Badge label={status} />}
    </div>
  );
}

// ─── SettledView — "Outcome" ────────────────────────

export function SettledView({ data, reasoning }: { data: Record<string, unknown>; reasoning?: string | null }) {
  const signal = getSnapshotSignal(data);
  const isFail = data.outcome === 'FAIL';

  if (isFail) {
    return (
      <div className="space-y-2">
        {reasoning && (
          <p className="text-xs text-muted-foreground bg-destructive/5 border border-destructive/20 rounded px-2 py-1.5">
            {reasoning}
          </p>
        )}
        {!reasoning && <FallbackJson data={data} />}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {signal ? (
        <div className="flex items-center gap-2 flex-wrap">
          {signal.action != null && <Badge label={String(signal.action)} />}
          {signal.orderType != null && <Badge label={String(signal.orderType)} />}
          {signal.tradeId != null && (
            <span className="text-foreground tabular-nums font-mono text-xs">
              trade {String(signal.tradeId).slice(0, 8)}
            </span>
          )}
        </div>
      ) : (
        <FallbackJson data={data} />
      )}
    </div>
  );
}

// ─── ErrorView — "What broke" ───────────────────────

export function ErrorView({ data }: { data: Record<string, unknown> }) {
  return (
    <p className="text-xs text-muted-foreground bg-destructive/5 border border-destructive/20 rounded px-2 py-1.5">
      {String(data.message ?? data.error ?? JSON.stringify(data))}
    </p>
  );
}

// ─── FallbackJson ───────────────────────────────────

export function FallbackJson({ data }: { data: unknown }) {
  return (
    <pre className="text-xs text-muted-foreground bg-muted/30 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-words">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
