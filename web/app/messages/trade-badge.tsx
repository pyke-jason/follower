import { TrendingUp, TrendingDown, LogOut } from 'lucide-react';

const VARIANTS = {
  Long: { bg: 'bg-[oklch(0.94_0.04_150)] text-[oklch(0.38_0.08_148)] dark:bg-[oklch(0.25_0.04_150)] dark:text-[oklch(0.75_0.12_150)]', icon: TrendingUp },
  Short: { bg: 'bg-[oklch(0.94_0.04_35)] text-[oklch(0.42_0.10_30)] dark:bg-[oklch(0.25_0.04_30)] dark:text-[oklch(0.72_0.14_28)]', icon: TrendingDown },
  Exit: { bg: 'bg-[oklch(0.94_0.03_250)] text-[oklch(0.42_0.08_248)] dark:bg-[oklch(0.25_0.03_250)] dark:text-[oklch(0.70_0.12_250)]', icon: LogOut },
} as const;

const DEFAULT = { bg: 'bg-[oklch(0.94_0.015_75)] text-[oklch(0.45_0.02_65)] dark:bg-[oklch(0.25_0.015_65)] dark:text-[oklch(0.65_0.02_70)]', icon: null };

export function TradeBadge({ label }: { label: string }) {
  const variant = VARIANTS[label as keyof typeof VARIANTS] ?? DEFAULT;
  const Icon = variant.icon;

  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-medium px-1.5 py-0.5 rounded ${variant.bg} align-middle`}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {label}
    </span>
  );
}
