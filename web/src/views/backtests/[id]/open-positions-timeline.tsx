import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatDate, formatDateShort, formatInteger } from '@/lib/format';
import { STRAT_COLOR, STRAT_ORDER } from '@/lib/strat-colors';
import type { Trade } from '@src/db/schema';
import type { Strategy } from '@src/lib/enums';

export type OpenPositionsTimelineMode = 'total' | 'by-strategy';

type OpenPositionsTimelineProps = {
  trades: Trade[];
  endIso: string;
  mode?: OpenPositionsTimelineMode;
};

type TimelinePoint = {
  timestamp: string;
  openPositions: number;
  opened: number;
  closed: number;
  /** Running open count per strategy at this timestamp. Always populated. */
  byStrategy: Partial<Record<Strategy, number>>;
};

function buildTimeline(trades: Trade[], endIso: string): TimelinePoint[] {
  const events = new Map<string, Map<Strategy, { opened: number; closed: number }>>();

  for (const trade of trades) {
    const strategy = trade.strategy;
    if (trade.openedAt) {
      const stratMap = events.get(trade.openedAt) ?? new Map<Strategy, { opened: number; closed: number }>();
      const entry = stratMap.get(strategy) ?? { opened: 0, closed: 0 };
      entry.opened += 1;
      stratMap.set(strategy, entry);
      events.set(trade.openedAt, stratMap);
    }
    if (trade.closedAt) {
      const stratMap = events.get(trade.closedAt) ?? new Map<Strategy, { opened: number; closed: number }>();
      const entry = stratMap.get(strategy) ?? { opened: 0, closed: 0 };
      entry.closed += 1;
      stratMap.set(strategy, entry);
      events.set(trade.closedAt, stratMap);
    }
  }

  const orderedEvents = Array.from(events.entries()).sort(([a], [b]) => a.localeCompare(b));
  if (orderedEvents.length === 0) return [];

  const runningByStrat = new Map<Strategy, number>();
  const points: TimelinePoint[] = orderedEvents.map(([timestamp, stratMap]) => {
    let opened = 0;
    let closed = 0;
    for (const [strategy, counts] of stratMap.entries()) {
      const next = (runningByStrat.get(strategy) ?? 0) + counts.opened - counts.closed;
      runningByStrat.set(strategy, next);
      opened += counts.opened;
      closed += counts.closed;
    }

    const byStrategy: Partial<Record<Strategy, number>> = {};
    let openPositions = 0;
    for (const [strategy, count] of runningByStrat.entries()) {
      if (count > 0) byStrategy[strategy] = count;
      openPositions += count;
    }

    return { timestamp, openPositions, opened, closed, byStrategy };
  });

  const lastPoint = points[points.length - 1];
  if (endIso > lastPoint.timestamp) {
    points.push({
      timestamp: endIso,
      openPositions: lastPoint.openPositions,
      opened: 0,
      closed: 0,
      byStrategy: { ...lastPoint.byStrategy },
    });
  }

  return points;
}

function TimelineTooltip({
  active,
  payload,
  label,
  mode,
}: {
  active?: boolean;
  payload?: Array<{ payload?: TimelinePoint }>;
  label?: string;
  mode: OpenPositionsTimelineMode;
}) {
  if (!active || !payload?.length || !payload[0]?.payload || !label) return null;
  const point = payload[0].payload;

  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-foreground">{formatDate(label)}</div>
      <div className="mt-1 text-muted-foreground">
        Open positions: <span className="font-medium text-foreground">{formatInteger(point.openPositions)}</span>
      </div>
      {mode === 'by-strategy' && (
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
          {STRAT_ORDER.map((s) => {
            const count = point.byStrategy[s] ?? 0;
            if (count === 0) return null;
            return (
              <div key={s} className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-sm" style={{ backgroundColor: STRAT_COLOR[s] }} />
                <span>{s}</span>
                <span className="ml-auto font-medium text-foreground tabular-nums">{count}</span>
              </div>
            );
          })}
        </div>
      )}
      {(point.opened > 0 || point.closed > 0) && (
        <div className="mt-1 space-y-0.5 text-muted-foreground">
          {point.opened > 0 && <div>Opened: {formatInteger(point.opened)}</div>}
          {point.closed > 0 && <div>Closed: {formatInteger(point.closed)}</div>}
        </div>
      )}
    </div>
  );
}

export function OpenPositionsTimeline({ trades, endIso, mode = 'total' }: OpenPositionsTimelineProps) {
  const data = useMemo(() => buildTimeline(trades, endIso), [trades, endIso]);

  if (data.length === 0) return null;

  const sharedAxes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
      <XAxis
        dataKey="timestamp"
        tickFormatter={formatDateShort}
        tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
        axisLine={{ stroke: 'var(--color-border)' }}
        tickLine={false}
      />
      <YAxis
        allowDecimals={false}
        tickFormatter={formatInteger}
        tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
        axisLine={false}
        tickLine={false}
      />
      <Tooltip content={<TimelineTooltip mode={mode} />} />
      <ReferenceLine
        y={0}
        stroke="var(--color-muted-foreground)"
        strokeDasharray="3 3"
        strokeOpacity={0.5}
      />
    </>
  );

  if (mode === 'by-strategy') {
    return (
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {sharedAxes}
          {STRAT_ORDER.map((s) => (
            <Area
              key={s}
              type="stepAfter"
              dataKey={(p: TimelinePoint) => p.byStrategy[s] ?? 0}
              name={s}
              stackId="1"
              stroke={STRAT_COLOR[s]}
              fill={STRAT_COLOR[s]}
              fillOpacity={0.45}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        {sharedAxes}
        <Line
          type="stepAfter"
          dataKey="openPositions"
          name="Open positions"
          stroke="var(--color-chart-2)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
