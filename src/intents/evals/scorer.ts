import type { EvalCase, EvalResult, FieldScore, ExpectedSignal, ExpectedLeg } from './types.js';
import type { OrchestratorResult, ResolvedSignal, OptionLeg, Leg } from '../orchestrator/types.js';
import { normalizeExpiry } from '../../lib/occ-symbology.js';
import { getOptionLegs } from '../../lib/trade.js';

export const PASS_THRESHOLD = 0.8;

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

/** Narrow a Leg to OptionLeg, or undefined if stock. */
function asOptionLeg(leg: Leg | undefined): OptionLeg | undefined {
  return leg?.type === 'option' ? leg : undefined;
}

/** Score a single leg comparison. Accepts any Leg type (stock or option). */
function scoreLeg(
  prefix: string,
  expectedLeg: ExpectedLeg,
  actualLeg: Leg | undefined,
  refDate: Date,
): FieldScore[] {
  const scores: FieldScore[] = [];
  const actualOption = asOptionLeg(actualLeg);

  if (expectedLeg.optionType != null) {
    scores.push({
      field: `${prefix}.optionType`,
      matched: expectedLeg.optionType === actualOption?.optionType,
      expected: expectedLeg.optionType,
      actual: actualOption?.optionType,
    });
  }

  if (expectedLeg.side != null) {
    scores.push({
      field: `${prefix}.side`,
      matched: expectedLeg.side === actualLeg?.side,
      expected: expectedLeg.side,
      actual: actualLeg?.side,
    });
  }

  if (expectedLeg.strike != null) {
    const actualStrike = actualOption?.strike;
    const matched = actualStrike != null && Math.abs(actualStrike - expectedLeg.strike) < 0.5;
    scores.push({
      field: `${prefix}.strike`,
      matched,
      expected: expectedLeg.strike,
      actual: actualStrike,
    });
  }

  if (expectedLeg.expiry != null) {
    const matched = compareExpiry(expectedLeg.expiry, actualOption?.expiry, refDate);
    scores.push({
      field: `${prefix}.expiry`,
      matched,
      expected: expectedLeg.expiry,
      actual: actualOption?.expiry,
    });
  }

  return scores;
}

/** Count the number of scored fields for an expected signal (for scoring misses). */
function countExpectedFields(expectedSig: ExpectedSignal): number {
  let count = 0;
  if (expectedSig.orderType != null) count++;
  if (expectedSig.exitPercent != null) count++;
  if (expectedSig.symbol != null) count++;
  if (expectedSig.legs != null) {
    count++; // legs.count
    for (const leg of expectedSig.legs) {
      if (leg.optionType != null) count++;
      if (leg.side != null) count++;
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
  actualSig: ResolvedSignal,
  refDate: Date,
): FieldScore[] {
  const scores: FieldScore[] = [];

  if (expectedSig.orderType != null) {
    scores.push({
      field: `${sigPrefix}.orderType`,
      matched: expectedSig.orderType === actualSig.orderType,
      expected: expectedSig.orderType,
      actual: actualSig.orderType,
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

  if (expectedSig.symbol != null) {
    const actualSymbol = actualSig.legs[0]?.symbol;
    scores.push({
      field: `${sigPrefix}.symbol`,
      matched: expectedSig.symbol.toUpperCase() === actualSymbol?.toUpperCase(),
      expected: expectedSig.symbol,
      actual: actualSymbol,
    });
  }

  if (expectedSig.legs != null) {
    const actualLegs = actualSig.legs;

    scores.push({
      field: `${sigPrefix}.legs.count`,
      matched: expectedSig.legs.length === actualLegs.length,
      expected: expectedSig.legs.length,
      actual: actualLegs.length,
    });

    const usedActualIndices = new Set<number>();

    for (let j = 0; j < expectedSig.legs.length; j++) {
      const expectedLeg = expectedSig.legs[j];
      const legPrefix = `${sigPrefix}.legs[${j}]`;

      // Try to find matching actual leg by optionType first
      let matchedActualIndex = -1;
      if (expectedLeg.optionType != null) {
        for (let k = 0; k < actualLegs.length; k++) {
          const aLeg = asOptionLeg(actualLegs[k]);
          if (!usedActualIndices.has(k) && aLeg?.optionType === expectedLeg.optionType) {
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
  orchestratorResult: OrchestratorResult,
  refDate: Date,
): EvalResult {
  const { expected } = evalCase;
  const fieldScores: FieldScore[] = [];
  const actualSignals = orchestratorResult.outcome === 'EXECUTE' ? orchestratorResult.signals : [];

  // Gate: outcome mismatch -> score 0
  // mustMatch paths including 'outcome' are implicitly covered — score 0 means passed=false regardless.
  if (orchestratorResult.outcome !== expected.outcome) {
    return {
      caseId: evalCase.id,
      description: evalCase.description,
      passed: false,
      hardFail: (evalCase.mustMatch ?? []).includes('outcome'),
      score: 0,
      fieldScores: [],
      hardFailFields: (evalCase.mustMatch ?? []).includes('outcome') ? ['outcome'] : [],
      actualDecision: orchestratorResult.outcome,
      expectedDecision: expected.outcome,
      actualSignals,
      durationMs: 0,
      tags: evalCase.tags ?? [],
    };
  }

  // Outcome matches with no expected signals -> perfect score
  if (!expected.signals || expected.signals.length === 0) {
    return {
      caseId: evalCase.id,
      description: evalCase.description,
      passed: true,
      hardFail: false,
      score: 1.0,
      fieldScores: [],
      hardFailFields: [],
      actualDecision: orchestratorResult.outcome,
      expectedDecision: expected.outcome,
      actualSignals,
      durationMs: 0,
      tags: evalCase.tags ?? [],
    };
  }

  // Score each expected signal
  for (let i = 0; i < expected.signals.length; i++) {
    const expectedSig = expected.signals[i];
    const sigPrefix = `signals[${i}]`;

    // Match expected signal to actual by leg optionTypes
    let actualSig: ResolvedSignal | undefined;
    if (actualSignals.length > 0) {
      // Try matching by leg optionType composition
      const expectedOptionTypes = expectedSig.legs
        ?.map(l => l.optionType)
        .filter(Boolean)
        .sort() ?? [];

      if (expectedOptionTypes.length > 0) {
        actualSig = actualSignals.find(s => {
          const actualOptionTypes = getOptionLegs(s.legs)
            .map(l => l.optionType)
            .sort();
          if (actualOptionTypes.length !== expectedOptionTypes.length) return false;
          return actualOptionTypes.every((t, idx) => t === expectedOptionTypes[idx]);
        });
      }

      // Fall back to positional match
      if (!actualSig && i < actualSignals.length) {
        actualSig = actualSignals[i];
      }
    }

    if (!actualSig) {
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

  // Check mustMatch paths by looking up the already-computed fieldScores.
  // 'outcome' is always satisfied here (gate above handles mismatch).
  const hardFailFields: string[] = [];
  for (const path of (evalCase.mustMatch ?? [])) {
    if (path === 'outcome') continue; // already matched at the gate
    const entry = fieldScores.find(f => f.field === path);
    if (!entry || !entry.matched) hardFailFields.push(path);
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
    actualDecision: orchestratorResult.outcome,
    expectedDecision: expected.outcome,
    actualSignals,
    durationMs: 0,
    tags: evalCase.tags ?? [],
  };
}
