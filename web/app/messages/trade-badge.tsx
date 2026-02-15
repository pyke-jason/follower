import { TrendingUp, TrendingDown, LogOut } from 'lucide-react';

const VARIANTS = {
  Long: { bg: 'bg-emerald-900/60 text-emerald-300', icon: TrendingUp },
  Short: { bg: 'bg-red-900/60 text-red-300', icon: TrendingDown },
  Exit: { bg: 'bg-blue-900/60 text-blue-300', icon: LogOut },
} as const;

const DEFAULT = { bg: 'bg-zinc-800 text-zinc-300', icon: null };

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
