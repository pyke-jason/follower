import type { Signal } from '../../src/agent/schemas';

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

export function strikesMatch(expected: number[] | null, got: number[] | undefined): boolean {
  const e = expected ?? [];
  const g = got ?? [];
  if (e.length !== g.length) return false;
  const eSorted = [...e].sort((a, b) => a - b);
  const gSorted = [...g].sort((a, b) => a - b);
  return eSorted.every((v, i) => Math.abs(v - gSorted[i]) <= 0.01);
}

// ─── Core comparison ────────────────────────────────

type LabelRow = {
  messageId: string;
  isTrade: boolean | null;
  action: string | null;
  direction: string | null;
  strategy: string | null;
  symbol: string | null;
  price: string | null;
  strikes: number[] | null;
};

type IntentRow = {
  decision: string;
  signals: Signal[] | null;
};

/**
 * Compare a set of labels against matching intents and produce accuracy metrics.
 * This is the core logic shared by both global eval and per-backtest accuracy.
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
    const signals = (intent.signals ?? []) as Signal[];
    const signal = signals[0];
    let rowAllCorrect = true;

    // isTrade (EXECUTE vs SKIP classification)
    fields.isTrade.total++;
    const intentIsTrade = intent.decision === 'EXECUTE' && signals.length > 0;
    const labelIsTrade = label.isTrade === true;
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

    // Only compare detail fields when BOTH say it's a trade
    if (intentIsTrade && labelIsTrade && signal) {
      // Action
      fields.action.total++;
      if (normalizeNull(signal.action) === normalizeNull(label.action)) {
        fields.action.correct++;
      } else {
        rowAllCorrect = false;
        failures.push({
          messageId: label.messageId,
          cleanText: cleanText.slice(0, 80),
          field: 'action',
          expected: normalizeNull(label.action) ?? 'null',
          got: normalizeNull(signal.action) ?? 'null',
        });
      }

      // Direction
      fields.direction.total++;
      if (normalizeNull(signal.direction) === normalizeNull(label.direction)) {
        fields.direction.correct++;
      } else {
        rowAllCorrect = false;
        failures.push({
          messageId: label.messageId,
          cleanText: cleanText.slice(0, 80),
          field: 'direction',
          expected: normalizeNull(label.direction) ?? 'null',
          got: normalizeNull(signal.direction) ?? 'null',
        });
      }

      // Strategy
      fields.strategy.total++;
      if (normalizeNull(signal.strategy) === normalizeNull(label.strategy)) {
        fields.strategy.correct++;
      } else {
        rowAllCorrect = false;
        failures.push({
          messageId: label.messageId,
          cleanText: cleanText.slice(0, 80),
          field: 'strategy',
          expected: normalizeNull(label.strategy) ?? 'null',
          got: normalizeNull(signal.strategy) ?? 'null',
        });
      }

      // Symbol (case-insensitive)
      fields.symbol.total++;
      const intentSymbol = normalizeNull(signal.symbol)?.toUpperCase() ?? null;
      const labelSymbol = normalizeNull(label.symbol)?.toUpperCase() ?? null;
      if (intentSymbol === labelSymbol) {
        fields.symbol.correct++;
      } else {
        rowAllCorrect = false;
        failures.push({
          messageId: label.messageId,
          cleanText: cleanText.slice(0, 80),
          field: 'symbol',
          expected: labelSymbol ?? 'null',
          got: intentSymbol ?? 'null',
        });
      }

      // Price (only when label has a price)
      if (label.price != null) {
        fields.price.total++;
        const intentPrice = normalizeNull(signal.limitPrice);
        const labelPrice = normalizeNull(label.price);
        if (priceMatch(labelPrice, intentPrice)) {
          fields.price.correct++;
        } else {
          rowAllCorrect = false;
          failures.push({
            messageId: label.messageId,
            cleanText: cleanText.slice(0, 80),
            field: 'price',
            expected: labelPrice ?? 'null',
            got: intentPrice ?? 'null',
          });
        }
      }

      // Strikes (only when label has strikes)
      if (label.strikes && label.strikes.length > 0) {
        fields.strikes.total++;
        const intentStrikes = signal.legs?.map((l) => parseFloat(l.strike as unknown as string));
        if (strikesMatch(label.strikes, intentStrikes)) {
          fields.strikes.correct++;
        } else {
          rowAllCorrect = false;
          failures.push({
            messageId: label.messageId,
            cleanText: cleanText.slice(0, 80),
            field: 'strikes',
            expected: JSON.stringify(label.strikes),
            got: JSON.stringify(intentStrikes ?? []),
          });
        }
      }
    }

    if (rowAllCorrect) allCorrect++;
  }

  const totalLabels = pairs.length;

  const fieldResults: Record<FieldName, FieldResult> = {} as any;
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
