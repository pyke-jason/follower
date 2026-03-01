import { Badge } from './badge';
import { StatItem } from './stat-item';
import { InfoChip } from './info-chip';

export type LegRow = {
  symbol?: string;
  strike?: number;
  expiry?: string;
  type?: string;
  action?: string;
  side?: string;
  quantity?: number;
};

export function ParseResultView({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
      {data.action != null ? (
        <StatItem label="Action">
          <Badge label={String(data.action)} />
        </StatItem>
      ) : null}
      {data.symbol != null ? (
        <StatItem label="Symbol">
          <InfoChip label={String(data.symbol)} />
        </StatItem>
      ) : null}
      {data.strategy != null ? (
        <StatItem label="Strategy">
          <Badge label={String(data.strategy)} />
        </StatItem>
      ) : null}
      {data.direction != null ? (
        <StatItem label="Direction">
          <Badge label={String(data.direction)} />
        </StatItem>
      ) : null}
      {Array.isArray(data.strikes) ? (
        <StatItem label="Strikes">
          <span className="text-foreground tabular-nums font-medium">
            {(data.strikes as number[]).join(' / ')}
          </span>
        </StatItem>
      ) : null}
      {data.expiry != null ? (
        <StatItem label="Expiry">
          <span className="text-foreground tabular-nums">{String(data.expiry)}</span>
        </StatItem>
      ) : null}
      {data.price != null ? (
        <StatItem label="Price">
          <span className="text-foreground tabular-nums">${String(data.price)}</span>
        </StatItem>
      ) : null}
      {data.quantity != null ? (
        <StatItem label="Quantity">
          <span className="text-foreground tabular-nums">{String(data.quantity)}</span>
        </StatItem>
      ) : null}
      {data.limitPrice != null ? (
        <StatItem label="Limit Price">
          <span className="text-foreground tabular-nums">${String(data.limitPrice)}</span>
        </StatItem>
      ) : null}
      {typeof data.confidence === 'number' ? (
        <StatItem label="Confidence">
          <span className="text-foreground tabular-nums">
            {`${(data.confidence * 100).toFixed(0)}%`}
          </span>
        </StatItem>
      ) : null}
    </div>
  );
}

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
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="pr-3 py-1 font-medium">Symbol</th>
                <th className="pr-3 py-1 font-medium">Strike</th>
                <th className="pr-3 py-1 font-medium">Expiry</th>
                <th className="pr-3 py-1 font-medium">Type</th>
                <th className="pr-3 py-1 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg, i) => (
                <tr key={i} className="border-t border-border/30">
                  <td className="pr-3 py-1 tabular-nums">{leg.symbol ?? '--'}</td>
                  <td className="pr-3 py-1 tabular-nums">{leg.strike ?? '--'}</td>
                  <td className="pr-3 py-1 tabular-nums">{leg.expiry ?? '--'}</td>
                  <td className="pr-3 py-1">{leg.type ? <Badge label={leg.type} /> : '--'}</td>
                  <td className="pr-3 py-1">{leg.action ?? leg.side ?? '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SizedView({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
      {data.symbol != null ? (
        <StatItem label="Symbol">
          <InfoChip label={String(data.symbol)} />
        </StatItem>
      ) : null}
      {data.strategy != null ? (
        <StatItem label="Strategy">
          <Badge label={String(data.strategy)} />
        </StatItem>
      ) : null}
      {data.direction != null ? (
        <StatItem label="Direction">
          <Badge label={String(data.direction)} />
        </StatItem>
      ) : null}
      {data.entryPrice != null ? (
        <StatItem label="Entry Price">
          <span className="text-foreground tabular-nums">${String(data.entryPrice)}</span>
        </StatItem>
      ) : null}
      {data.quantity != null ? (
        <StatItem label="Quantity">
          <span className="text-foreground tabular-nums font-medium">{String(data.quantity)}</span>
        </StatItem>
      ) : null}
      {data.riskPerTrade != null ? (
        <StatItem label="Risk/Trade">
          <span className="text-foreground tabular-nums">${String(data.riskPerTrade)}</span>
        </StatItem>
      ) : null}
      {data.reasoning != null ? (
        <div className="col-span-full">
          <StatItem label="Reasoning">
            <span className="text-foreground/80 text-xs">{String(data.reasoning)}</span>
          </StatItem>
        </div>
      ) : null}
    </div>
  );
}

export function OrderPlacedView({ data }: { data: Record<string, unknown> }) {
  const legs = Array.isArray(data.legs) ? (data.legs as LegRow[]) : [];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        {data.orderId != null ? (
          <StatItem label="Order ID">
            <span className="text-foreground tabular-nums font-mono text-xs">{String(data.orderId)}</span>
          </StatItem>
        ) : null}
        {data.orderType != null ? (
          <StatItem label="Order Type">
            <Badge label={String(data.orderType)} />
          </StatItem>
        ) : null}
        {data.status != null ? (
          <StatItem label="Status">
            <Badge label={String(data.status)} />
          </StatItem>
        ) : null}
        {data.limitPrice != null ? (
          <StatItem label="Limit Price">
            <span className="text-foreground tabular-nums">${String(data.limitPrice)}</span>
          </StatItem>
        ) : null}
        {data.symbol != null ? (
          <StatItem label="Symbol">
            <InfoChip label={String(data.symbol)} />
          </StatItem>
        ) : null}
        {data.direction != null ? (
          <StatItem label="Direction">
            <Badge label={String(data.direction)} />
          </StatItem>
        ) : null}
      </div>
      {legs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="pr-3 py-1 font-medium">Symbol</th>
                <th className="pr-3 py-1 font-medium">Strike</th>
                <th className="pr-3 py-1 font-medium">Expiry</th>
                <th className="pr-3 py-1 font-medium">Type</th>
                <th className="pr-3 py-1 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg, i) => (
                <tr key={i} className="border-t border-border/30">
                  <td className="pr-3 py-1 tabular-nums">{leg.symbol ?? '--'}</td>
                  <td className="pr-3 py-1 tabular-nums">{leg.strike ?? '--'}</td>
                  <td className="pr-3 py-1 tabular-nums">{leg.expiry ?? '--'}</td>
                  <td className="pr-3 py-1">{leg.type ? <Badge label={leg.type} /> : '--'}</td>
                  <td className="pr-3 py-1">{leg.action ?? leg.side ?? '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function OrderFilledView({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
      {data.orderId != null ? (
        <StatItem label="Order ID">
          <span className="text-foreground tabular-nums font-mono text-xs">{String(data.orderId)}</span>
        </StatItem>
      ) : null}
      {data.filledPrice != null ? (
        <StatItem label="Fill Price">
          <span className="text-foreground tabular-nums font-medium">${String(data.filledPrice)}</span>
        </StatItem>
      ) : null}
      {data.fillTimestamp != null ? (
        <StatItem label="Filled At">
          <span className="text-foreground tabular-nums text-xs">{String(data.fillTimestamp)}</span>
        </StatItem>
      ) : null}
      {data.commission != null ? (
        <StatItem label="Commission">
          <span className="text-foreground tabular-nums">${String(data.commission)}</span>
        </StatItem>
      ) : null}
      {data.adjustmentCount != null ? (
        <StatItem label="Chases">
          <span className="text-foreground tabular-nums">{String(data.adjustmentCount)}</span>
        </StatItem>
      ) : null}
      {data.originalLimitPrice != null ? (
        <StatItem label="Original Limit">
          <span className="text-foreground tabular-nums">${String(data.originalLimitPrice)}</span>
        </StatItem>
      ) : null}
    </div>
  );
}

export function OrderCancelledView({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
      {data.orderId != null ? (
        <StatItem label="Order ID">
          <span className="text-foreground tabular-nums font-mono text-xs">{String(data.orderId)}</span>
        </StatItem>
      ) : null}
      {data.symbol != null ? (
        <StatItem label="Symbol">
          <InfoChip label={String(data.symbol)} />
        </StatItem>
      ) : null}
      {data.originalLimitPrice != null ? (
        <StatItem label="Original Limit">
          <span className="text-foreground tabular-nums">${String(data.originalLimitPrice)}</span>
        </StatItem>
      ) : null}
      {data.finalLimitPrice != null ? (
        <StatItem label="Final Limit">
          <span className="text-foreground tabular-nums">${String(data.finalLimitPrice)}</span>
        </StatItem>
      ) : null}
      {data.adjustmentCount != null ? (
        <StatItem label="Chases">
          <span className="text-foreground tabular-nums">{String(data.adjustmentCount)}</span>
        </StatItem>
      ) : null}
      {data.reason != null ? (
        <StatItem label="Reason">
          <Badge label={String(data.reason)} />
        </StatItem>
      ) : null}
    </div>
  );
}

export function SettledView({ data, reasoning }: { data: Record<string, unknown>; reasoning?: string | null }) {
  const signal = data.signal as Record<string, unknown> | undefined;
  const legs = signal && Array.isArray(signal.legs) ? (signal.legs as LegRow[]) : [];
  const isFail = data.outcome === 'FAIL';

  return (
    <div className="space-y-2">
      {/* Error reason — prominent for failures */}
      {isFail && reasoning && (
        <p className="text-xs text-muted-foreground bg-destructive/5 border border-destructive/20 rounded px-2 py-1.5">
          {reasoning}
        </p>
      )}

      {/* Signal summary */}
      {signal && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          {signal.action != null && (
            <StatItem label="Action">
              <Badge label={String(signal.action)} />
            </StatItem>
          )}
          {signal.orderType != null && (
            <StatItem label="Order Type">
              <Badge label={String(signal.orderType)} />
            </StatItem>
          )}
          {signal.tradeId != null && (
            <StatItem label="Trade">
              <span className="text-foreground tabular-nums font-mono text-xs">{String(signal.tradeId).slice(0, 8)}</span>
            </StatItem>
          )}
        </div>
      )}

      {/* Legs table */}
      {legs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="pr-3 py-1 font-medium">Symbol</th>
                <th className="pr-3 py-1 font-medium">Strike</th>
                <th className="pr-3 py-1 font-medium">Expiry</th>
                <th className="pr-3 py-1 font-medium">Type</th>
                <th className="pr-3 py-1 font-medium">Side</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg, i) => (
                <tr key={i} className="border-t border-border/30">
                  <td className="pr-3 py-1 tabular-nums">{leg.symbol ?? '--'}</td>
                  <td className="pr-3 py-1 tabular-nums">{leg.strike ?? '--'}</td>
                  <td className="pr-3 py-1 tabular-nums">{leg.expiry ?? '--'}</td>
                  <td className="pr-3 py-1">{leg.type ? <Badge label={String(leg.type)} /> : '--'}</td>
                  <td className="pr-3 py-1">{leg.action ?? leg.side ?? '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Anything else not covered above */}
      {!signal && <FallbackJson data={data} />}
    </div>
  );
}

export function ErrorView({ data }: { data: Record<string, unknown> }) {
  return (
    <p className="text-xs text-muted-foreground bg-destructive/5 border border-destructive/20 rounded px-2 py-1.5">
      {String(data.message ?? data.error ?? JSON.stringify(data))}
    </p>
  );
}

export function FallbackJson({ data }: { data: unknown }) {
  return (
    <pre className="text-xs text-muted-foreground bg-muted/30 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-words">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
