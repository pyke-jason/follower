import { cn } from '@/lib/utils';
import { AnimatedNumber } from './animated-number';
import { Sparkline } from './sparkline';

export interface Metric {
  label: string;
  value: number;
  format?: 'currency' | 'percent' | 'integer' | 'decimal';
  colorBySign?: boolean;
  sparklineData?: number[];
  prefix?: string;
  suffix?: string;
}

interface MetricStripProps {
  metrics: Metric[];
  className?: string;
}

export function MetricStrip({ metrics, className }: MetricStripProps) {
  return (
    <div
      className={cn(
        'grid gap-3 animate-in-up',
        metrics.length <= 3 && 'grid-cols-3',
        metrics.length === 4 && 'grid-cols-2 md:grid-cols-4',
        metrics.length === 5 && 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5',
        metrics.length >= 6 && 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6',
        className
      )}
    >
      {metrics.map((metric, i) => (
        <div
          key={metric.label}
          className={cn(
            'flex flex-col gap-1 rounded-lg border bg-card px-4 py-3',
            `stagger-${i + 1}`
          )}
        >
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {metric.label}
          </span>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xl font-semibold tracking-tight">
              {metric.prefix}
              <AnimatedNumber
                value={metric.value}
                format={metric.format}
                colorBySign={metric.colorBySign}
              />
              {metric.suffix}
            </span>
            {metric.sparklineData && metric.sparklineData.length > 1 && (
              <Sparkline data={metric.sparklineData} width={64} height={28} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
