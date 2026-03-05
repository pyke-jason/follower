import { formatLegsSummary } from '@src/lib/trade';
import type { TradeLeg } from '@src/db/schema';

export function LegsIndicator({ legs, strategy }: { legs: TradeLeg[] | null; strategy: string }) {
  if (!legs || legs.length === 0) return null;

  const summary = formatLegsSummary(legs, strategy);
  if (!summary) return null;

  return <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">{summary}</span>;
}
