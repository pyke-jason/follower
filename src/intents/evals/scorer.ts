import type { EvalCase, EvalResult, FieldScore } from './types.js';
import type { Signal } from '../../agent/schemas.js';
import { normalizeExpiry } from '../../backtest/occ-symbology.js';

export const PASS_THRESHOLD = 0.8;

type ActualLeg = { strike: number; expiry?: string; optionType: 'CALL' | 'PUT'; action: 'BUY' | 'SELL' };
type ExpectedLeg = { strike?: number; expiry?: string; optionType?: 'CALL' | 'PUT'; action?: 'BUY' | 'SELL' };

/** Compare two expiry strings using normalizeExpiry semantics. */
function compareExpiry(
  expectedExpiry: string,
  actualExpiry: string | undefined,
  refDate: Date,
): boolean {
  if (expectedExpiry === 'LEAP') {
    if (!actualExpiry) return false;
    try {
      const normalized = normalizeExpiry(actualExpiry, refDate);
      const [year, month, day] = normalized.split('-').map(Number);
      const expiryDate = new Date(Date.UTC(year, month - 1, day));
      const sixMonthsOut = new Date(Date.UTC(
        refDate.getUTCFullYear(),
        refDate.getUTCMonth() + 6,
        refDate.getUTCDate(),
      ));
      return expiryDate >= sixMonthsOut;
    } catch {
      return false;
    }
  }

  if (!actualExpiry) return false;

  try {
    const normalizedExpected = normalizeExpiry(expectedExpiry, refDate);
    const normalizedActual = normalizeExpiry(actualExpiry, refDate);
    return normalizedExpected === normalizedActual;
  } catch {
    return false;
  }
}

/** Resolve a mustMatch path to a { matched, expected, actual } tuple. */
function resolveMustMatchPath(
  path: string,
  evalCase: EvalCase,
  actual: { decision: string; signals?: Signal[] },
  refDate: Date,
): { matched: boolean; expected: unknown; actual: unknown } {
  if (path === 'decision') {
    const exp = evalCase.expected.decision;
    const act = actual.decision;
    return { matched: exp === act, expected: exp, actual: act };
  }

  const signalMatch = path.match(/^signals\[(\d+)\]\.(.+)$/);
  if (!signalMatch) {
    return { matched: false, expected: undefined, actual: undefined };
  }

  const signalIdx = parseInt(signalMatch[1], 10);
  const rest = signalMatch[2];
  const expectedSignal = evalCase.expected.signals?.[signalIdx];
  const actualSignal = actual.signals?.[signalIdx];

  const legMatch = rest.match(/^legs\[(\d+)\]\.(.+)$/);
  if (legMatch) {
    const legIdx = parseInt(legMatch[1], 10);
    const field = legMatch[2];
    const expectedLeg = expectedSignal?.legs?.[legIdx];
    const actualLeg = actualSignal?.legs?.[legIdx] as ActualLeg | undefined;

    if (field === 'expiry') {
      const expExpiry = expectedLeg?.expiry;
      const actExpiry = actualLeg?.expiry;
      if (expExpiry == null) return { matched: true, expected: expExpiry, actual: actExpiry };
      const matched = compareExpiry(expExpiry, actExpiry, refDate);
      return { matched, expected: expExpiry, actual: actExpiry };
    }

    const expVal = expectedLeg ? (expectedLeg as Record<string, unknown>)[field] : undefined;
    const actVal = actualLeg ? (actualLeg as Record<string, unknown>)[field] : undefined;
    return { matched: expVal === actVal, expected: expVal, actual: actVal };
  }

  // signals[N].field (top-level signal field)
  const expVal = expectedSignal ? (expectedSignal as Record<string, unknown>)[rest] : undefined;
  const actVal = actualSignal ? (actualSignal as Record<string, unknown>)[rest] : undefined;
  return { matched: expVal === actVal, expected: expVal, actual: actVal };
}

/** Score a single leg comparison. */
function scoreLeg(
  prefix: string,
  expectedLeg: ExpectedLeg,
  actualLeg: ActualLeg | undefined,
  refDate: Date,
): FieldScore[] {
  const scores: FieldScore[] = [];

  if (expectedLeg.optionType != null) {
    scores.push({
      field: `${prefix}.optionType`,
      matched: expectedLeg.optionType === actualLeg?.optionType,
      expected: expectedLeg.optionType,
      actual: actualLeg?.optionType,
    });
  }

  if (expectedLeg.action != null) {
    scores.push({
      field: `${prefix}.action`,
      matched: expectedLeg.action === actualLeg?.action,
      expected: expectedLeg.action,
      actual: actualLeg?.action,
    });
  }

  if (expectedLeg.strike != null) {
    const actualStrike = actualLeg?.strike;
    const matched = actualStrike != null && Math.abs(actualStrike - expectedLeg.strike) < 0.5;
    scores.push({
      field: `${prefix}.strike`,
      matched,
      expected: expectedLeg.strike,
      actual: actualStrike,
    });
  }

  if (expectedLeg.expiry != null) {
    const matched = compareExpiry(expectedLeg.expiry, actualLeg?.expiry, refDate);
    scores.push({
      field: `${prefix}.expiry`,
      matched,
      expected: expectedLeg.expiry,
      actual: actualLeg?.expiry,
    });
  }

  return scores;
}

type ExpectedSignal = NonNullable<EvalCase['expected']['signals']>[number];

/** Count the number of scored fields for an expected signal (for scoring misses). */
function countExpectedFields(expectedSig: ExpectedSignal): number {
  let count = 1; // action always scored
  if (expectedSig.symbol != null) count++;
  if (expectedSig.direction != null) count++;
  if (expectedSig.strategy != null) count++;
  if (expectedSig.exitPercent != null) count++;
  if (expectedSig.targetStrategy != null) count++;
  if (expectedSig.statedPremium != null) count++;
  if (expectedSig.legs != null) {
    count++; // legs.count
    for (const leg of expectedSig.legs) {
      if (leg.optionType != null) count++;
      if (leg.action != null) count++;
      if (leg.strike != null) count++;
      if (leg.expiry != null) count++;
    }
  }
  return count;
}

/** Score all fields of a matched signal pair. */
function scoreSignal(
  sigPrefix: string,
  expectedSig: ExpectedSignal,
  actualSig: Signal,
  refDate: Date,
): FieldScore[] {
  const scores: FieldScore[] = [];

  scores.push({
    field: `${sigPrefix}.action`,
    matched: expectedSig.action === actualSig.action,
    expected: expectedSig.action,
    actual: actualSig.action,
  });

  if (expectedSig.symbol != null) {
    scores.push({
      field: `${sigPrefix}.symbol`,
      matched: expectedSig.symbol.toLowerCase() === actualSig.symbol.toLowerCase(),
      expected: expectedSig.symbol,
      actual: actualSig.symbol,
    });
  }

  if (expectedSig.direction != null) {
    scores.push({
      field: `${sigPrefix}.direction`,
      matched: expectedSig.direction === actualSig.direction,
      expected: expectedSig.direction,
      actual: actualSig.direction,
    });
  }

  if (expectedSig.strategy != null) {
    scores.push({
      field: `${sigPrefix}.strategy`,
      matched: expectedSig.strategy === actualSig.strategy,
      expected: expectedSig.strategy,
      actual: actualSig.strategy,
    });
  }

  if (expectedSig.exitPercent != null) {
    const actualExit = actualSig.exitPercent;
    const matched = actualExit != null && Math.abs(actualExit - expectedSig.exitPercent) < 0.01;
    scores.push({
      field: `${sigPrefix}.exitPercent`,
      matched,
      expected: expectedSig.exitPercent,
      actual: actualExit,
    });
  }

  if (expectedSig.targetStrategy != null) {
    scores.push({
      field: `${sigPrefix}.targetStrategy`,
      matched: expectedSig.targetStrategy === actualSig.targetStrategy,
      expected: expectedSig.targetStrategy,
      actual: actualSig.targetStrategy,
    });
  }

  if (expectedSig.statedPremium != null) {
    const actualPremium = actualSig.statedPremium;
    const matched = actualPremium != null && Math.abs(actualPremium - expectedSig.statedPremium) < 0.01;
    scores.push({
      field: `${sigPrefix}.statedPremium`,
      matched,
      expected: expectedSig.statedPremium,
      actual: actualPremium,
    });
  }

  if (expectedSig.legs != null) {
    scores.push({
      field: `${sigPrefix}.legs.count`,
      matched: expectedSig.legs.length === (actualSig.legs?.length ?? 0),
      expected: expectedSig.legs.length,
      actual: actualSig.legs?.length ?? 0,
    });

    const actualLegs = (actualSig.legs ?? []) as ActualLeg[];
    const usedActualIndices = new Set<number>();

    for (let j = 0; j < expectedSig.legs.length; j++) {
      const expectedLeg = expectedSig.legs[j];
      const legPrefix = `${sigPrefix}.legs[${j}]`;

      // Try to find matching actual leg by optionType+action first
      let matchedActualIndex = -1;
      if (expectedLeg.optionType != null) {
        for (let k = 0; k < actualLegs.length; k++) {
          if (!usedActualIndices.has(k) && actualLegs[k].optionType === expectedLeg.optionType) {
            matchedActualIndex = k;
            break;
          }
        }
      }

      // Fall back to positional match among unused legs
      if (matchedActualIndex === -1) {
        for (let k = 0; k < actualLegs.length; k++) {
          if (!usedActualIndices.has(k)) {
            matchedActualIndex = k;
            break;
          }
        }
      }

      const actualLeg = matchedActualIndex >= 0 ? actualLegs[matchedActualIndex] : undefined;
      if (matchedActualIndex >= 0) usedActualIndices.add(matchedActualIndex);

      scores.push(...scoreLeg(legPrefix, expectedLeg, actualLeg, refDate));
    }
  }

  return scores;
}

export function scoreCase(
  evalCase: EvalCase,
  actual: { decision: string; signals?: Signal[] },
  refDate: Date,
): EvalResult {
  const { expected } = evalCase;
  const fieldScores: FieldScore[] = [];

  // Gate: decision mismatch → score 0 (not a hard fail, just wrong classification)
  if (actual.decision !== expected.decision) {
    return {
      caseId: evalCase.id,
      description: evalCase.description,
      passed: false,
      hardFail: false,
      score: 0,
      fieldScores: [],
      hardFailFields: [],
      actualDecision: actual.decision,
      expectedDecision: expected.decision,
      actualSignals: actual.signals ?? [],
      durationMs: 0,
      tags: evalCase.tags ?? [],
    };
  }

  // Decision matches with no expected signals → perfect score
  if (!expected.signals || expected.signals.length === 0) {
    return {
      caseId: evalCase.id,
      description: evalCase.description,
      passed: true,
      hardFail: false,
      score: 1.0,
      fieldScores: [],
      hardFailFields: [],
      actualDecision: actual.decision,
      expectedDecision: expected.decision,
      actualSignals: actual.signals ?? [],
      durationMs: 0,
      tags: evalCase.tags ?? [],
    };
  }

  // Score each expected signal
  for (let i = 0; i < expected.signals.length; i++) {
    const expectedSig = expected.signals[i];
    const sigPrefix = `signals[${i}]`;

    const actualSig = actual.signals?.find(
      s =>
        s.action === expectedSig.action &&
        (expectedSig.symbol == null ||
          s.symbol.toLowerCase() === expectedSig.symbol.toLowerCase()),
    );

    if (!actualSig) {
      // No matching actual signal — count all expected fields as misses
      const missCount = countExpectedFields(expectedSig);
      for (let k = 0; k < missCount; k++) {
        fieldScores.push({
          field: `${sigPrefix}.missing_${k}`,
          matched: false,
          expected: '(expected signal not found)',
          actual: undefined,
        });
      }
      continue;
    }

    fieldScores.push(...scoreSignal(sigPrefix, expectedSig, actualSig, refDate));
  }

  const totalFields = fieldScores.length;
  const matchedFields = fieldScores.filter(f => f.matched).length;
  const score = totalFields === 0 ? 1.0 : matchedFields / totalFields;

  // Check mustMatch paths
  const hardFailFields: string[] = [];
  for (const path of (evalCase.mustMatch ?? [])) {
    const { matched } = resolveMustMatchPath(path, evalCase, actual, refDate);
    if (!matched) hardFailFields.push(path);
  }

  const hardFail = hardFailFields.length > 0;
  const passed = !hardFail && score >= PASS_THRESHOLD;

  return {
    caseId: evalCase.id,
    description: evalCase.description,
    passed,
    hardFail,
    score,
    fieldScores,
    hardFailFields,
    actualDecision: actual.decision,
    expectedDecision: expected.decision,
    actualSignals: actual.signals ?? [],
    durationMs: 0,
    tags: evalCase.tags ?? [],
  };
}
