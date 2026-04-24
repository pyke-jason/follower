export function SymbolBadge({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex items-center rounded-[4px] border border-info/25 bg-info/5 px-1.5 py-0 text-[11px] leading-5 font-mono font-semibold text-info align-baseline">
      {symbol}
    </span>
  );
}
