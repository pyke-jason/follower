import { Hash } from 'lucide-react';

export function SymbolBadge({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium px-1.5 py-0.5 rounded bg-sky-900/50 text-sky-300 font-mono align-middle">
      <Hash className="w-3 h-3" />
      {symbol}
    </span>
  );
}
