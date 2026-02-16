import { Hash } from 'lucide-react';

export function SymbolBadge({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium px-1.5 py-0.5 rounded bg-[oklch(0.94_0.03_250)] text-[oklch(0.42_0.08_248)] dark:bg-[oklch(0.25_0.03_250)] dark:text-[oklch(0.70_0.12_250)] font-mono align-middle">
      <Hash className="w-3 h-3" />
      {symbol}
    </span>
  );
}
