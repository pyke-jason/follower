/**
 * Shared eval comparison logic.
 * Compares label signals (human ground truth) against intent signals (AI extraction).
 */

import type { Signal } from '../agent/schemas.js';

// ─── Types ───────────────────────────────────────────

export type FieldName = 'isTrade' | 'action' | 'direction' | 'strategy' | 'symbol' | 'price' | 'strikes';

export type FieldResult = { correct: number; total: number; accuracy: number | null };

export type Failure = {
  messageId: string;
  cleanText: string;
  field: string;
  expected: string;
  got: string;
};

export type AccuracyResult = {
  totalLabels: number;
  fields: Record<FieldName, FieldResult>;
  overallAccuracy: number | null;
  failures: Failure[];
};

// ─── Comparison helpers ──────────────────────────────

export function normalizeNull(v: unknown): string | null {
  if (v === undefined || v === null || v === '' || v === 'null') return null;
  return String(v);
}

export function priceMatch(expected: string | null, got: string | null): boolean {
  if (expected === null && got === null) return true;
  if (expected === null || got === null) return false;
  const e = parseFloat(expected);
  const g = parseFloat(got);
  if (isNaN(e) || isNaN(g)) return expected === got;
  return Math.abs(e - g) <= 0.05;
}

export function strikesMatch(expected: number[] | undefined, got: number[] | undefined): boolean {
  const e = expected ?? [];
  const g = got ?? [];
  if (e.length !== g.length) return false;
  const eSorted = [...e].sort((a, b) => a - b);
  const gSorted = [...g].sort((a, b) => a - b);
  return eSorted.every((v, i) => Math.abs(v - gSorted[i]) <= 0.01);
}

// ─── Quick match check ─────────────────────────────

/** Returns true if label signals match intent signals (no mismatch). */
export function compareSignals(
  labelSignals: Signal[],
  intent: { decision: string; signals: Signal[] | null },
): boolean {
  const intentSignals = (intent.signals ?? []) as Signal[];
  const labelIsTrade = labelSignals.length > 0;
  const intentIsTrade = intent.decision === 'EXECUTE' && intentSignals.length > 0;

  if (labelIsTrade !== intentIsTrade) return false;
  if (!labelIsTrade) return true; // both agree: not a trade

  const ls = labelSignals[0];
  const is_ = intentSignals[0];
  if (!ls || !is_) return false;

  if (normalizeNull(ls.action) !== normalizeNull(is_.action)) return false;
  if (normalizeNull(ls.direction) !== normalizeNull(is_.direction)) return false;
  if (normalizeNull(ls.strategy) !== normalizeNull(is_.strategy)) return false;
  if (normalizeNull(ls.symbol)?.toUpperCase() !== normalizeNull(is_.symbol)?.toUpperCase()) return false;

  const labelPrice = normalizeNull(ls.statedPremium);
  if (labelPrice != null && !priceMatch(labelPrice, normalizeNull(is_.statedPremium))) return false;

  const labelStrikes = extractStrikes(ls);
  if (labelStrikes && labelStrikes.length > 0 && !strikesMatch(labelStrikes, extractStrikes(is_))) return false;

  return true;
}

// ─── Core comparison ────────────────────────────────

type LabelRow = {
  messageId: string;
  signals: Signal[] | null;
};

type IntentRow = {
  decision: string;
  signals: Signal[] | null;
};

function extractStrikes(signal: Signal): number[] | undefined {
  return signal.legs?.map((l) => (typeof l.strike === 'string' ? parseFloat(l.strike) : l.strike));
}

/**
 * Compare label signals against intent signals to produce accuracy metrics.
 * Both sides now use Signal[], so comparison is straightforward.
 */
export function compareLabelsVsIntents(
  pairs: { label: LabelRow; intent: IntentRow; cleanText: string }[],
): AccuracyResult {
  const fields: Record<FieldName, { correct: number; total: number }> = {
    isTrade:   { correct: 0, total: 0 },
    action:    { correct: 0, total: 0 },
    direction: { correct: 0, total: 0 },
    strategy:  { correct: 0, total: 0 },
    symbol:    { correct: 0, total: 0 },
    price:     { correct: 0, total: 0 },
    strikes:   { correct: 0, total: 0 },
  };

  let allCorrect = 0;
  const failures: Failure[] = [];

  for (const { label, intent, cleanText } of pairs) {
    const labelSignals = label.signals ?? [];
    const intentSignals = (intent.signals ?? []) as Signal[];
    let rowAllCorrect = true;

    // isTrade: does this message contain a trade?
    fields.isTrade.total++;
    const labelIsTrade = labelSignals.length > 0;
    const intentIsTrade = intent.decision === 'EXECUTE' && intentSignals.length > 0;
    if (intentIsTrade === labelIsTrade) {
      fields.isTrade.correct++;
    } else {
      rowAllCorrect = false;
      failures.push({
        messageId: label.messageId,
        cleanText: cleanText.slice(0, 80),
        field: 'isTrade',
        expected: String(labelIsTrade),
        got: String(intentIsTrade),
      });
    }

    // Compare signal-by-signal (primary signal = index 0)
    if (intentIsTrade && labelIsTrade) {
      const ls = labelSignals[0];
      const is_ = intentSignals[0];

      if (ls && is_) {
        // Action
        fields.action.total++;
        if (normalizeNull(ls.action) === normalizeNull(is_.action)) {
          fields.action.correct++;
        } else {
          rowAllCorrect = false;
          failures.push({
            messageId: label.messageId, cleanText: cleanText.slice(0, 80),
            field: 'action', expected: ls.action ?? 'null', got: is_.action ?? 'null',
          });
        }

        // Direction
        fields.direction.total++;
        if (normalizeNull(ls.direction) === normalizeNull(is_.direction)) {
          fields.direction.correct++;
        } else {
          rowAllCorrect = false;
          failures.push({
            messageId: label.messageId, cleanText: cleanText.slice(0, 80),
            field: 'direction', expected: ls.direction ?? 'null', got: is_.direction ?? 'null',
          });
        }

        // Strategy
        fields.strategy.total++;
        if (normalizeNull(ls.strategy) === normalizeNull(is_.strategy)) {
          fields.strategy.correct++;
        } else {
          rowAllCorrect = false;
          failures.push({
            messageId: label.messageId, cleanText: cleanText.slice(0, 80),
            field: 'strategy', expected: ls.strategy ?? 'null', got: is_.strategy ?? 'null',
          });
        }

        // Symbol (case-insensitive)
        fields.symbol.total++;
        const labelSymbol = normalizeNull(ls.symbol)?.toUpperCase() ?? null;
        const intentSymbol = normalizeNull(is_.symbol)?.toUpperCase() ?? null;
        if (intentSymbol === labelSymbol) {
          fields.symbol.correct++;
        } else {
          rowAllCorrect = false;
          failures.push({
            messageId: label.messageId, cleanText: cleanText.slice(0, 80),
            field: 'symbol', expected: labelSymbol ?? 'null', got: intentSymbol ?? 'null',
          });
        }

        // Price (only when label has one)
        const labelPrice = normalizeNull(ls.statedPremium);
        if (labelPrice != null) {
          fields.price.total++;
          const intentPrice = normalizeNull(is_.statedPremium);
          if (priceMatch(labelPrice, intentPrice)) {
            fields.price.correct++;
          } else {
            rowAllCorrect = false;
            failures.push({
              messageId: label.messageId, cleanText: cleanText.slice(0, 80),
              field: 'price', expected: labelPrice, got: intentPrice ?? 'null',
            });
          }
        }

        // Strikes (only when label has legs)
        const labelStrikes = extractStrikes(ls);
        if (labelStrikes && labelStrikes.length > 0) {
          fields.strikes.total++;
          const intentStrikes = extractStrikes(is_);
          if (strikesMatch(labelStrikes, intentStrikes)) {
            fields.strikes.correct++;
          } else {
            rowAllCorrect = false;
            failures.push({
              messageId: label.messageId, cleanText: cleanText.slice(0, 80),
              field: 'strikes', expected: JSON.stringify(labelStrikes), got: JSON.stringify(intentStrikes ?? []),
            });
          }
        }
      }
    }

    if (rowAllCorrect) allCorrect++;
  }

  const totalLabels = pairs.length;

  const fieldResults = {} as Record<FieldName, FieldResult>;
  for (const [name, result] of Object.entries(fields)) {
    fieldResults[name as FieldName] = {
      ...result,
      accuracy: result.total > 0 ? result.correct / result.total : null,
    };
  }

  return {
    totalLabels,
    fields: fieldResults,
    overallAccuracy: totalLabels > 0 ? allCorrect / totalLabels : null,
    failures,
  };
}
