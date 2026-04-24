import { useMemo } from 'react';
import {
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
import type { Trade } from '@src/db/schema';

type OpenPositionsTimelineProps = {
  trades: Trade[];
  endIso: string;
};

type TimelinePoint = {
  timestamp: string;
  openPositions: number;
  opened: number;
  closed: number;
};

function buildTimeline(trades: Trade[], endIso: string): TimelinePoint[] {
  const events = new Map<string, { opened: number; closed: number }>();

  for (const trade of trades) {
    if (trade.openedAt) {
      const entry = events.get(trade.openedAt) ?? { opened: 0, closed: 0 };
      entry.opened += 1;
      events.set(trade.openedAt, entry);
    }
    if (trade.closedAt) {
      const entry = events.get(trade.closedAt) ?? { opened: 0, closed: 0 };
      entry.closed += 1;
      events.set(trade.closedAt, entry);
    }
  }

  const orderedEvents = Array.from(events.entries()).sort(([a], [b]) => a.localeCompare(b));
  if (orderedEvents.length === 0) return [];

  let openPositions = 0;
  const points = orderedEvents.map(([timestamp, counts]) => {
    openPositions += counts.opened - counts.closed;
    return {
      timestamp,
      openPositions,
      opened: counts.opened,
      closed: counts.closed,
    };
  });

  const lastPoint = points[points.length - 1];
  if (endIso > lastPoint.timestamp) {
    points.push({
      timestamp: endIso,
      openPositions: lastPoint.openPositions,
      opened: 0,
      closed: 0,
    });
  }

  return points;
}

function TimelineTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload?: TimelinePoint }>;
  label?: string;
}) {
  if (!active || !payload?.length || !payload[0]?.payload || !label) return null;
  const point = payload[0].payload;

  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-foreground">{formatDate(label)}</div>
      <div className="mt-1 text-muted-foreground">
        Open positions: <span className="font-medium text-foreground">{formatInteger(point.openPositions)}</span>
      </div>
      {(point.opened > 0 || point.closed > 0) && (
        <div className="mt-1 space-y-0.5 text-muted-foreground">
          {point.opened > 0 && <div>Opened: {formatInteger(point.opened)}</div>}
          {point.closed > 0 && <div>Closed: {formatInteger(point.closed)}</div>}
        </div>
      )}
    </div>
  );
}

export function OpenPositionsTimeline({ trades, endIso }: OpenPositionsTimelineProps) {
  const data = useMemo(() => buildTimeline(trades, endIso), [trades, endIso]);

  if (data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
        <Tooltip content={<TimelineTooltip />} />
        <ReferenceLine
          y={0}
          stroke="var(--color-muted-foreground)"
          strokeDasharray="3 3"
          strokeOpacity={0.5}
        />
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
