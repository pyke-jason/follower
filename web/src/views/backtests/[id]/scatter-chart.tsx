import {
  ScatterChart as RechartsScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import type { ContentType } from 'recharts/types/component/Tooltip';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';

type ScatterSeries = {
  key: string;
  label: string;
  color: string;
  data: Record<string, unknown>[];
};

type ReferenceLineConfig = {
  y: number;
  label?: string;
  color?: string;
  strokeDasharray?: string;
};

/**
 * Props consumed by caller-provided scatter tooltip components. Callers receive
 * Recharts' runtime payload wrapped with their own per-point shape `TPayload`.
 * Each payload entry carries an optional `payload` field (Recharts may omit it
 * when a series has no active point) — callers must handle the undefined case.
 */
export type ScatterTooltipProps<TPayload> = {
  active?: boolean;
  payload?: Array<{ payload?: TPayload }>;
};

type ScatterPlotChartProps<TPayload = unknown> = {
  series: ScatterSeries[];
  xKey: string;
  yKey: string;
  zKey?: string;
  height?: number;
  formatX?: (v: string) => string;
  formatY?: (v: number) => string;
  tooltipContent?: (props: ScatterTooltipProps<TPayload>) => React.ReactNode;
  referenceLines?: ReferenceLineConfig[];
  zRange?: [number, number];
};

export function ScatterPlotChart<TPayload = unknown>({
  series,
  xKey,
  yKey,
  zKey,
  height = 300,
  formatX,
  formatY,
  tooltipContent,
  referenceLines,
  zRange = [30, 200],
}: ScatterPlotChartProps<TPayload>) {
  // Bridge the caller's narrow tooltip (typed against a domain-specific
  // payload shape) into Recharts' Tooltip, which passes `Payload<ValueType, NameType>`.
  // `Payload.payload` is typed `any` upstream — so we destructure and repackage
  // it into our `ScatterTooltipProps<TPayload>` shape. No cast needed because
  // `any` is assignable to `TPayload | undefined` at the destructure site.
  const bridge: ContentType<ValueType, NameType> | undefined = tooltipContent
    ? (props) => {
        const items = props.payload?.map(({ payload }: { payload?: TPayload }) => ({
          payload,
        }));
        return tooltipContent({ active: props.active, payload: items });
      }
    : undefined;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey={xKey}
          tickFormatter={formatX}
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--color-border)' }}
          tickLine={false}
          type="category"
          allowDuplicatedCategory={false}
        />
        <YAxis
          dataKey={yKey}
          tickFormatter={formatY}
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          type="number"
        />
        {zKey && <ZAxis dataKey={zKey} range={zRange} />}
        {referenceLines?.map((rl, i) => (
          <ReferenceLine
            key={`ref-${i}`}
            y={rl.y}
            stroke={rl.color ?? 'var(--color-muted-foreground)'}
            strokeDasharray={rl.strokeDasharray ?? '3 3'}
            strokeOpacity={0.6}
            label={rl.label ? {
              value: rl.label,
              position: 'insideTopRight',
              fill: 'var(--color-muted-foreground)',
              fontSize: 10,
            } : undefined}
          />
        ))}
        {bridge ? (
          <Tooltip content={bridge} />
        ) : (
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: 'var(--color-foreground)' }}
          />
        )}
        <Legend
          wrapperStyle={{ fontSize: 12, color: 'var(--color-muted-foreground)' }}
        />
        {series.map((s) => (
          <Scatter
            key={s.key}
            name={s.label}
            data={s.data}
            fill={s.color}
            fillOpacity={0.7}
          />
        ))}
      </RechartsScatterChart>
    </ResponsiveContainer>
  );
}
