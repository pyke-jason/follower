/**
 * Synthesize raw `Signal[]` (the flat label-shared schema) from a parser-only
 * decision so every SETTLED snapshot can carry a 1:1-with-label `classifierSignals`
 * payload regardless of whether the LLM path ran.
 *
 * Contract:
 * - Hard-skip → `[]`
 * - Deterministic OPEN/ADD/CLOSE/TRIM/LEG_OFF → one Signal populated from the parse result.
 * - Strangle OPEN → two Signals (CALL + PUT, both LONG).
 */

import type { Signal } from '@/agent/schemas.js';
import type { ParseResult } from './types.js';
import { canonicalizeSignals } from '@/eval/canonical-signal.js';

function toSignal(parse: ParseResult): Signal {
  return {
    action: parse.action ?? 'OPEN',
    symbol: parse.symbol ?? '',
    direction: parse.direction ?? null,
    strategy: parse.strategy ?? null,
    strikes: parse.strikes ?? null,
    expiry: parse.expiryHint ?? null,
    statedPrice: parse.premiumHint ?? null,
    quantity: null,
    ...(parse.exitPercent != null ? { exitPercent: parse.exitPercent } : {}),
    ...(parse.targetStrategy != null ? { targetStrategy: parse.targetStrategy } : {}),
  };
}

export function synthesizeDeterministicSignals(parse: ParseResult): Signal[] {
  if (parse.isHardSkip) return [];

  if (parse.isStrangle && parse.action !== 'CLOSE' && parse.action !== 'TRIM' && parse.action !== 'LEG_OFF') {
    const base = toSignal({ ...parse, direction: 'LONG' });
    return canonicalizeSignals([
      { ...base, strategy: 'CALL' },
      { ...base, strategy: 'PUT' },
    ]);
  }

  if (!parse.symbol) return [];

  // No badge and no action verb detected → commentary/setup, not a trade.
  // Without action, we'd emit a skeleton OPEN signal that inflates false positives.
  if (parse.action == null) return [];

  return canonicalizeSignals([toSignal(parse)]);
}
