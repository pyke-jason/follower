/**
 * Eval comparison logic — compares agent labels against human-verified golden labels.
 *
 * Source of truth:
 * - EvalLabelData in src/db/schema.ts
 * - Signal in src/agent/schemas.ts
 */

import { db, schema } from '@/db/client.js';
import { eq, and, count, sql } from 'drizzle-orm';
import type { EvalLabelData } from '@/db/schema.js';
import type { Signal } from '@/agent/schemas.js';

type EvalFieldName =
  | 'isTrade'
  | 'tradeCount'
  | 'signalCount'
  | 'action'
  | 'direction'
  | 'symbol'
  | 'strategy'
  | 'strikes'
  | 'expiry'
  | 'statedPrice'
  | 'quantity'
  | 'exitPercent'
  | 'targetStrategy';

type FieldResult = { correct: number; total: number; accuracy: number | null };

type ConfusionMatrix = {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
};

type EvalFailure = {
  messageId: string;
  cleanText: string;
  field: string;
  expected: string;
  got: string;
  reasoning: string;
};

type EvalMetricsResult = {
  totalVerified: number;
  fields: Record<EvalFieldName, FieldResult>;
  confusion: ConfusionMatrix;
  overallAccuracy: number | null;
};

type EvalSummary = {
  totalLabels: number;
  humanVerified: number;
  bySource: { agent: number; human: number };
  lowConfidence: number;
  metrics: EvalMetricsResult | null;
};

type FieldCounter = { correct: number; total: number };

function normalizeScalar(value: unknown): string | null {
  if (value == null || value === '') return null;
  return String(value).trim().toUpperCase();
}

function normalizeExpiry(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  return value.trim().toLowerCase();
}

function numberEqual(a: number | null | undefined, b: number | null | undefined, tolerance = 0.01): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= tolerance;
}

function strikesEqual(
  expected: number[] | null | undefined,
  got: number[] | null | undefined,
  tolerance = 0.01,
): boolean {
  const e = expected ?? null;
  const g = got ?? null;
  if (e == null || g == null) return e == null && g == null;
  if (e.length !== g.length) return false;
  return e.every((strike, index) => numberEqual(strike, g[index], tolerance));
}

function displayValue(value: unknown): string {
  if (value == null) return 'null';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function compareField(
  fields: Record<EvalFieldName, FieldCounter>,
  field: EvalFieldName,
  matches: boolean,
): boolean {
  fields[field].total++;
  if (matches) {
    fields[field].correct++;
    return true;
  }
  return false;
}

function compareOptionalField<T>(
  fields: Record<EvalFieldName, FieldCounter>,
  field: EvalFieldName,
  expected: T | null | undefined,
  got: T | null | undefined,
  matches: boolean,
): boolean {
  if (expected == null && got == null) return true;
  return compareField(fields, field, matches);
}

function compareSignals(
  expected: Signal,
  predicted: Signal,
  fields: Record<EvalFieldName, FieldCounter>,
): boolean {
  let allCorrect = true;

  allCorrect = compareField(fields, 'action', expected.action === predicted.action) && allCorrect;
  allCorrect = compareField(
    fields,
    'direction',
    normalizeScalar(expected.direction) === normalizeScalar(predicted.direction),
  ) && allCorrect;
  allCorrect = compareField(
    fields,
    'symbol',
    normalizeScalar(expected.symbol) === normalizeScalar(predicted.symbol),
  ) && allCorrect;
  allCorrect = compareField(
    fields,
    'strategy',
    normalizeScalar(expected.strategy) === normalizeScalar(predicted.strategy),
  ) && allCorrect;

  allCorrect = compareOptionalField(
    fields,
    'strikes',
    expected.strikes,
    predicted.strikes,
    strikesEqual(expected.strikes, predicted.strikes),
  ) && allCorrect;

  allCorrect = compareOptionalField(
    fields,
    'expiry',
    expected.expiry,
    predicted.expiry,
    normalizeExpiry(expected.expiry) === normalizeExpiry(predicted.expiry),
  ) && allCorrect;

  allCorrect = compareOptionalField(
    fields,
    'statedPrice',
    expected.statedPrice,
    predicted.statedPrice,
    numberEqual(expected.statedPrice, predicted.statedPrice),
  ) && allCorrect;

  allCorrect = compareOptionalField(
    fields,
    'quantity',
    expected.quantity,
    predicted.quantity,
    numberEqual(expected.quantity, predicted.quantity, 0),
  ) && allCorrect;

  allCorrect = compareOptionalField(
    fields,
    'exitPercent',
    expected.exitPercent,
    predicted.exitPercent,
    numberEqual(expected.exitPercent, predicted.exitPercent),
  ) && allCorrect;

  allCorrect = compareOptionalField(
    fields,
    'targetStrategy',
    expected.targetStrategy,
    predicted.targetStrategy,
    normalizeScalar(expected.targetStrategy) === normalizeScalar(predicted.targetStrategy),
  ) && allCorrect;

  return allCorrect;
}

function initialFieldCounters(): Record<EvalFieldName, FieldCounter> {
  return {
    isTrade:         { correct: 0, total: 0 },
    tradeCount:      { correct: 0, total: 0 },
    signalCount:     { correct: 0, total: 0 },
    action:          { correct: 0, total: 0 },
    direction:       { correct: 0, total: 0 },
    symbol:          { correct: 0, total: 0 },
    strategy:        { correct: 0, total: 0 },
    strikes:         { correct: 0, total: 0 },
    expiry:          { correct: 0, total: 0 },
    statedPrice:     { correct: 0, total: 0 },
    quantity:        { correct: 0, total: 0 },
    exitPercent:     { correct: 0, total: 0 },
    targetStrategy:  { correct: 0, total: 0 },
  };
}

function labelTrades(label: EvalLabelData): Signal[][] {
  return label.isTrade ? (label.trades ?? []) : [];
}

async function computeEvalMetrics(options?: { version?: number }): Promise<EvalMetricsResult> {
  const conditions = [eq(schema.evalLabels.humanVerified, true)];
  if (options?.version != null) {
    conditions.push(eq(schema.evalLabels.version, options.version));
  }

  const rows = await db.select({
    label: schema.evalLabels.label,
    humanLabel: schema.evalLabels.humanLabel,
  }).from(schema.evalLabels).where(and(...conditions));

  const fields = initialFieldCounters();
  const confusion: ConfusionMatrix = {
    truePositive: 0,
    falsePositive: 0,
    trueNegative: 0,
    falseNegative: 0,
  };
  let allCorrect = 0;

  for (const row of rows) {
    const predicted = row.label;
    const expected = row.humanLabel ?? row.label;
    const expectedTrades = labelTrades(expected);
    const predictedTrades = labelTrades(predicted);
    let rowCorrect = true;

    rowCorrect = compareField(fields, 'isTrade', predicted.isTrade === expected.isTrade) && rowCorrect;

    if (expected.isTrade && predicted.isTrade) {
      if (compareField(fields, 'tradeCount', expectedTrades.length === predictedTrades.length) === false) {
        rowCorrect = false;
      }

      const tradeCount = Math.min(expectedTrades.length, predictedTrades.length);
      for (let tradeIndex = 0; tradeIndex < tradeCount; tradeIndex++) {
        const expectedSignals = expectedTrades[tradeIndex] ?? [];
        const predictedSignals = predictedTrades[tradeIndex] ?? [];

        if (compareField(fields, 'signalCount', expectedSignals.length === predictedSignals.length) === false) {
          rowCorrect = false;
        }

        const signalCount = Math.min(expectedSignals.length, predictedSignals.length);
        for (let signalIndex = 0; signalIndex < signalCount; signalIndex++) {
          if (!compareSignals(expectedSignals[signalIndex], predictedSignals[signalIndex], fields)) {
            rowCorrect = false;
          }
        }

        if (expectedSignals.length !== predictedSignals.length) {
          rowCorrect = false;
        }
      }

      if (expectedTrades.length !== predictedTrades.length) {
        rowCorrect = false;
      }
    }

    if (expected.isTrade && predicted.isTrade) confusion.truePositive++;
    else if (!expected.isTrade && predicted.isTrade) confusion.falsePositive++;
    else if (!expected.isTrade && !predicted.isTrade) confusion.trueNegative++;
    else confusion.falseNegative++;

    if (rowCorrect) allCorrect++;
  }

  const fieldResults = {} as Record<EvalFieldName, FieldResult>;
  for (const [name, result] of Object.entries(fields)) {
    fieldResults[name as EvalFieldName] = {
      correct: result.correct,
      total: result.total,
      accuracy: result.total > 0 ? result.correct / result.total : null,
    };
  }

  const totalVerified = rows.length;
  return {
    totalVerified,
    fields: fieldResults,
    confusion,
    overallAccuracy: totalVerified > 0 ? allCorrect / totalVerified : null,
  };
}

async function getEvalFailures(options?: { version?: number; field?: string }): Promise<EvalFailure[]> {
  const conditions = [eq(schema.evalLabels.humanVerified, true)];
  if (options?.version != null) {
    conditions.push(eq(schema.evalLabels.version, options.version));
  }

  const rows = await db.select({
    messageId: schema.evalLabels.messageId,
    label: schema.evalLabels.label,
    humanLabel: schema.evalLabels.humanLabel,
  }).from(schema.evalLabels).where(and(...conditions));

  const messageIds = rows.map((row) => row.messageId);
  const messages = messageIds.length > 0
    ? await db.select({ id: schema.messages.id, cleanText: schema.messages.cleanText })
      .from(schema.messages)
      .where(sql`${schema.messages.id} IN (${sql.join(messageIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const messageText = new Map(messages.map((message) => [message.id, message.cleanText]));

  const failures: EvalFailure[] = [];

  for (const row of rows) {
    const predicted = row.label;
    const expected = row.humanLabel ?? row.label;
    const cleanText = messageText.get(row.messageId) ?? '';
    const expectedTrades = labelTrades(expected);
    const predictedTrades = labelTrades(predicted);

    const check = (field: string, exp: unknown, got: unknown) => {
      if (options?.field && options.field !== field) return;
      if (displayValue(exp) === displayValue(got)) return;
      failures.push({
        messageId: row.messageId,
        cleanText: cleanText.slice(0, 120),
        field,
        expected: displayValue(exp),
        got: displayValue(got),
        reasoning: predicted.reasoning,
      });
    };

    const checkMatch = (field: string, matches: boolean, exp: unknown, got: unknown) => {
      if (matches) return;
      check(field, exp, got);
    };

    checkMatch('isTrade', expected.isTrade === predicted.isTrade, expected.isTrade, predicted.isTrade);

    if (!(expected.isTrade && predicted.isTrade)) continue;

    checkMatch('tradeCount', expectedTrades.length === predictedTrades.length, expectedTrades.length, predictedTrades.length);

    const tradeCount = Math.min(expectedTrades.length, predictedTrades.length);
    for (let tradeIndex = 0; tradeIndex < tradeCount; tradeIndex++) {
      const expectedSignals = expectedTrades[tradeIndex] ?? [];
      const predictedSignals = predictedTrades[tradeIndex] ?? [];
      const tradePrefix = expectedTrades.length > 1 || predictedTrades.length > 1
        ? `trade[${tradeIndex}].`
        : '';

      checkMatch(
        `${tradePrefix}signalCount`,
        expectedSignals.length === predictedSignals.length,
        expectedSignals.length,
        predictedSignals.length,
      );

      const signalCount = Math.min(expectedSignals.length, predictedSignals.length);
      for (let signalIndex = 0; signalIndex < signalCount; signalIndex++) {
        const expectedSignal = expectedSignals[signalIndex];
        const predictedSignal = predictedSignals[signalIndex];
        const signalPrefix = `${tradePrefix}signal[${signalIndex}].`;

        checkMatch(
          `${signalPrefix}action`,
          expectedSignal.action === predictedSignal.action,
          expectedSignal.action,
          predictedSignal.action,
        );
        checkMatch(
          `${signalPrefix}direction`,
          normalizeScalar(expectedSignal.direction) === normalizeScalar(predictedSignal.direction),
          normalizeScalar(expectedSignal.direction),
          normalizeScalar(predictedSignal.direction),
        );
        checkMatch(
          `${signalPrefix}symbol`,
          normalizeScalar(expectedSignal.symbol) === normalizeScalar(predictedSignal.symbol),
          normalizeScalar(expectedSignal.symbol),
          normalizeScalar(predictedSignal.symbol),
        );
        checkMatch(
          `${signalPrefix}strategy`,
          normalizeScalar(expectedSignal.strategy) === normalizeScalar(predictedSignal.strategy),
          normalizeScalar(expectedSignal.strategy),
          normalizeScalar(predictedSignal.strategy),
        );

        if (expectedSignal.strikes != null || predictedSignal.strikes != null) {
          checkMatch(
            `${signalPrefix}strikes`,
            strikesEqual(expectedSignal.strikes, predictedSignal.strikes),
            expectedSignal.strikes,
            predictedSignal.strikes,
          );
        }
        if (expectedSignal.expiry != null || predictedSignal.expiry != null) {
          checkMatch(
            `${signalPrefix}expiry`,
            normalizeExpiry(expectedSignal.expiry) === normalizeExpiry(predictedSignal.expiry),
            normalizeExpiry(expectedSignal.expiry),
            normalizeExpiry(predictedSignal.expiry),
          );
        }
        if (expectedSignal.statedPrice != null || predictedSignal.statedPrice != null) {
          checkMatch(
            `${signalPrefix}statedPrice`,
            numberEqual(expectedSignal.statedPrice, predictedSignal.statedPrice),
            expectedSignal.statedPrice,
            predictedSignal.statedPrice,
          );
        }
        if (expectedSignal.quantity != null || predictedSignal.quantity != null) {
          checkMatch(
            `${signalPrefix}quantity`,
            numberEqual(expectedSignal.quantity, predictedSignal.quantity, 0),
            expectedSignal.quantity,
            predictedSignal.quantity,
          );
        }
        if (expectedSignal.exitPercent != null || predictedSignal.exitPercent != null) {
          checkMatch(
            `${signalPrefix}exitPercent`,
            numberEqual(expectedSignal.exitPercent, predictedSignal.exitPercent),
            expectedSignal.exitPercent,
            predictedSignal.exitPercent,
          );
        }
        if (expectedSignal.targetStrategy != null || predictedSignal.targetStrategy != null) {
          checkMatch(
            `${signalPrefix}targetStrategy`,
            normalizeScalar(expectedSignal.targetStrategy) === normalizeScalar(predictedSignal.targetStrategy),
            normalizeScalar(expectedSignal.targetStrategy),
            normalizeScalar(predictedSignal.targetStrategy),
          );
        }
      }
    }
  }

  return failures;
}

export async function getEvalSummary(): Promise<EvalSummary> {
  const [stats] = await db.select({
    total: count(),
    verified: sql<number>`SUM(CASE WHEN ${schema.evalLabels.humanVerified} IS TRUE THEN 1 ELSE 0 END)`,
    agent: sql<number>`SUM(CASE WHEN source = 'agent' THEN 1 ELSE 0 END)`,
    human: sql<number>`SUM(CASE WHEN source = 'human' THEN 1 ELSE 0 END)`,
    lowConf: sql<number>`SUM(CASE WHEN ${schema.evalLabels.label}->>'confidence' = 'LOW' THEN 1 ELSE 0 END)`,
  }).from(schema.evalLabels);

  const verified = Number(stats.verified ?? 0);
  return {
    totalLabels: stats.total,
    humanVerified: verified,
    bySource: {
      agent: Number(stats.agent ?? 0),
      human: Number(stats.human ?? 0),
    },
    lowConfidence: Number(stats.lowConf ?? 0),
    metrics: verified > 0 ? await computeEvalMetrics() : null,
  };
}
