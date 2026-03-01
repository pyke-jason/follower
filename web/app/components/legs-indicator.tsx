import type { TradeLeg } from '@src/db/schema';

export function LegsIndicator({ legs, strategy }: { legs: TradeLeg[] | null; strategy: string }) {
  if (strategy === 'STOCK' || !legs || legs.length === 0) return null;
  if (legs.every((l) => l.type === 'STOCK')) return null;

  const n = legs.length;
  const types = [...new Set(legs.map((l) => l.type).filter((t) => t !== 'STOCK'))];

  let label: string;
  if (n === 1) {
    label = `1L (${types[0]?.[0] ?? '?'})`;
  } else if (n === 2 && types.length === 1) {
    label = `${n}L (${types[0]![0]})`;
  } else {
    label = `${n}L${types.length > 0 ? ` (${types.map((t) => t[0]).join('/')})` : ''}`;
  }

  return <span className="text-[10px] text-muted-foreground tabular-nums">{label}</span>;
}
