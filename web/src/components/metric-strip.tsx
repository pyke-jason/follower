import { cn } from '@/lib/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { AnimatedNumber } from './animated-number';
import { Sparkline } from './sparkline';
import { pnlColor } from '@/lib/format';

export interface Metric {
  label: string;
  value: number;
  format?: 'currency' | 'percent' | 'integer' | 'decimal';
  colorBySign?: boolean;
  sparklineData?: number[];
  prefix?: string;
  suffix?: string;
  /** Small secondary line below the main value — e.g. "today realized: +$120". */
  secondary?: { label: string; value: number; format?: Metric['format']; colorBySign?: boolean };
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
        <Card
          key={metric.label}
          className={cn(
            'gap-0 py-0 hover-lift',
            `stagger-${i + 1}`
          )}
        >
          <CardHeader className="px-4 pt-3 pb-0">
            <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
              {metric.label}
            </span>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-1.5">
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
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
