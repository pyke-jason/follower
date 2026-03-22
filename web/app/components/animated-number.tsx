import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface AnimatedNumberProps {
  value: number;
  format?: 'currency' | 'percent' | 'integer' | 'decimal';
  colorBySign?: boolean;
  className?: string;
  duration?: number;
}

function formatValue(value: number, format: AnimatedNumberProps['format']): string {
  switch (format) {
    case 'currency':
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(value);
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    case 'integer':
      return Math.round(value).toLocaleString();
    case 'decimal':
      return value.toFixed(2);
    default:
      return value.toLocaleString();
  }
}

export function AnimatedNumber({
  value,
  format = 'decimal',
  colorBySign = false,
  className,
  duration = 600,
}: AnimatedNumberProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const previousValue = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const startValue = previousValue.current;
    const endValue = value;
    const startTime = performance.now();

    if (startValue === endValue) return;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = startValue + (endValue - startValue) * eased;

      setDisplayValue(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayValue(endValue);
        previousValue.current = endValue;
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  const signClass = colorBySign
    ? value > 0
      ? 'text-profit'
      : value < 0
        ? 'text-loss'
        : 'text-muted-foreground'
    : '';

  return (
    <span className={cn('tabular-nums transition-colors duration-300', signClass, className)}>
      {value > 0 && colorBySign ? '+' : ''}
      {formatValue(displayValue, format)}
    </span>
  );
}
