/**
 * Deterministic spread leg construction.
 *
 * Given strategy (PDS/CDS), direction (LONG/SHORT), and two strikes, the
 * complete leg structure is uniquely determined — no LLM reasoning needed.
 * The LLM only needs to emit the two strike numbers.
 *
 * See .claude/rules/llm-complexity-boundary.md for design rationale and
 * the canonical ordering rule (dominant leg first).
 */

export type SpreadLeg = {
  strike: number;
  action: 'BUY' | 'SELL';
  optionType: 'PUT' | 'CALL';
};

/**
 * Return the two legs for a spread in canonical order.
 *
 * Canonical ordering: dominant (first) leg determines price-chase direction
 * in OrderManager. SHORT spreads open with SELL first so the close order
 * reverses to BUY first → chases UP. LONG spreads open with BUY first so
 * the close reverses to SELL first → chases DOWN.
 *
 * ```
 * PDS SHORT  →  [SELL max PUT,  BUY  min PUT ]   put credit spread
 * PDS LONG   →  [BUY  max PUT,  SELL min PUT ]   put debit spread
 * CDS LONG   →  [BUY  min CALL, SELL max CALL]   call debit spread
 * CDS SHORT  →  [SELL min CALL, BUY  max CALL]   call credit spread
 * ```
 */
export function spreadLegs(
  strategy: 'PDS' | 'CDS',
  direction: 'LONG' | 'SHORT',
  s1: number,
  s2: number,
): SpreadLeg[] {
  const optionType = strategy === 'PDS' ? 'PUT' as const : 'CALL' as const;
  const hi = Math.max(s1, s2);
  const lo = Math.min(s1, s2);

  if (strategy === 'PDS') {
    return direction === 'SHORT'
      ? [{ strike: hi, action: 'SELL', optionType }, { strike: lo, action: 'BUY', optionType }]
      : [{ strike: hi, action: 'BUY',  optionType }, { strike: lo, action: 'SELL', optionType }];
  } else {
    return direction === 'LONG'
      ? [{ strike: lo, action: 'BUY',  optionType }, { strike: hi, action: 'SELL', optionType }]
      : [{ strike: lo, action: 'SELL', optionType }, { strike: hi, action: 'BUY',  optionType }];
  }
}
