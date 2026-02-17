/** Categorize a skip reasoning string into a human-readable bucket. */
export function categorizeSkipReason(reasoning: string): string {
  if (reasoning.startsWith('risk blocked:') || reasoning.includes('notional exposure')) return 'risk blocked';
  if (reasoning.startsWith('Execution error:') || reasoning.includes('No Databento data') || reasoning.includes('No price seeded')) return 'no market data';
  if (reasoning.includes('no open position') || reasoning.startsWith('No open position')) return 'no open position';
  if (reasoning.includes('sizing returned 0')) return 'sizing returned 0';
  if (reasoning.includes('limit order not filled')) return 'limit not filled';
  if (reasoning.includes('Low confidence') || reasoning.includes('agent disabled')) return 'low confidence';
  if (reasoning.includes('Agent budget')) return 'agent budget';
  if (reasoning.includes('no price') || reasoning.includes('no symbol') || reasoning.includes('no detected strategy')) return 'missing data';
  if (reasoning.includes('Agent error')) return 'agent error';
  if (reasoning.includes('Agent decided to skip')) return 'agent skip';
  if (reasoning.includes('paper trade')) return 'paper trade';
  if (reasoning.includes('no badges')) return 'no badges';
  if (reasoning.includes('ambiguous') || reasoning.includes('contradictory')) return 'ambiguous signal';
  if (reasoning.includes('unsupported') || reasoning.includes('calendar spread') || reasoning.includes('time spread')) return 'unsupported strategy';
  if (reasoning.includes('naked PUT') || reasoning.includes('naked CALL') || reasoning.includes('naked put') || reasoning.includes('naked call')) return 'naked option';
  if (reasoning.startsWith('Message from tracked trader') || reasoning.startsWith('CLEAR TRADE SIGNAL') || reasoning.startsWith('Message indicates') || reasoning.startsWith('Message contains')) return 'agent analysis';
  // Fallback: truncate long uncategorized reasons
  if (reasoning.length > 40) return 'other';
  return reasoning;
}

/** Aggregate skip reasons from an array of decisions, returning sorted [category, count] pairs. */
export function aggregateSkipReasons(
  decisions: { decision: string; reasoning: string | null; skipCategory?: string | null }[],
): [string, number][] {
  const counts = new Map<string, number>();
  for (const d of decisions) {
    if (d.decision !== 'SKIP' || !d.reasoning) continue;
    const category = d.skipCategory ?? categorizeSkipReason(d.reasoning);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
