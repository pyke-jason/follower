import { cn } from '@/lib/utils';

const VARIANTS = {
  Long: 'border-profit/20 bg-profit/5 text-profit',
  Short: 'border-loss/20 bg-loss/5 text-loss',
  Exit: 'border-info/20 bg-info/5 text-info',
} as const;

const DEFAULT = 'border-border/50 bg-muted/30 text-muted-foreground';

export function TradeBadge({ label }: { label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[4px] border px-1.5 py-0',
        'text-[11px] leading-5 font-medium align-baseline',
        VARIANTS[label as keyof typeof VARIANTS] ?? DEFAULT,
      )}
    >
      {label}
    </span>
  );
}
