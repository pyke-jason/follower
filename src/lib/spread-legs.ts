/**
 * Deterministic spread leg construction.
 *
 * Strategy alone determines which leg is BUY and which is SELL.
 * Direction is derived downstream from the legs — never an input here.
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
 * in OrderManager. Credit spreads open with SELL first so the close order
 * reverses to BUY first → chases UP. Debit spreads open with BUY first so
 * the close reverses to SELL first → chases DOWN.
 *
 * ```
 * PCS  →  [SELL max PUT,  BUY  min PUT ]   put credit spread (SHORT)
 * PDS  →  [BUY  max PUT,  SELL min PUT ]   put debit spread  (LONG)
 * CDS  →  [BUY  min CALL, SELL max CALL]   call debit spread (LONG)
 * ```
 */
export function spreadLegs(
  strategy: 'PCS' | 'PDS' | 'CDS',
  s1: number,
  s2: number,
): SpreadLeg[] {
  const hi = Math.max(s1, s2);
  const lo = Math.min(s1, s2);

  if (strategy === 'PCS') {
    return [
      { strike: hi, action: 'SELL', optionType: 'PUT' },
      { strike: lo, action: 'BUY', optionType: 'PUT' },
    ];
  } else if (strategy === 'PDS') {
    return [
      { strike: hi, action: 'BUY', optionType: 'PUT' },
      { strike: lo, action: 'SELL', optionType: 'PUT' },
    ];
  } else {
    // CDS
    return [
      { strike: lo, action: 'BUY', optionType: 'CALL' },
      { strike: hi, action: 'SELL', optionType: 'CALL' },
    ];
  }
}
