/**
 * Tests for percentage-based ChaseProfile system.
 *
 * Validates resolveChaseParams produces correct stepAmount, chaseLimit,
 * and maxSteps for various signal prices and profiles.
 * Validates selectChaseProfile routes to the correct profile.
 */

import { describe, test, expect } from 'vitest';
import { roundCents } from '../lib/numbers.js';
import {
  resolveChaseParams,
  selectChaseProfile,
  CHASE_PROFILES,
} from './execute-resolved.js';
import type { ChaseProfile } from './execute-resolved.js';
import type { Strategy } from '../lib/enums.js';

describe('resolveChaseParams', () => {
  test('step is clamped to minStep when signal price is very low', () => {
    const profile: ChaseProfile = { pctPerStep: 0.04, minStep: 0.02, maxStep: 0.25, maxSlippagePct: 0.50, intervalSec: 5 };
    // signalPrice = $0.10 → rawStep = 0.004 → clamped to minStep 0.02
    const result = resolveChaseParams(profile, 0.10, true);
    expect(result.stepAmount).toBe(0.02);
  });

  test('step is clamped to maxStep when signal price is very high', () => {
    const profile: ChaseProfile = { pctPerStep: 0.04, minStep: 0.02, maxStep: 0.25, maxSlippagePct: 0.50, intervalSec: 5 };
    // signalPrice = $100 → rawStep = 4.00 → clamped to maxStep 0.25
    const result = resolveChaseParams(profile, 100, true);
    expect(result.stepAmount).toBe(0.25);
  });

  test('step falls naturally between min and max', () => {
    const profile: ChaseProfile = { pctPerStep: 0.04, minStep: 0.02, maxStep: 0.25, maxSlippagePct: 0.50, intervalSec: 5 };
    // signalPrice = $3.00 → rawStep = 0.12 → within [0.02, 0.25]
    const result = resolveChaseParams(profile, 3.00, true);
    expect(result.stepAmount).toBe(0.12);
  });

  test('BUY chaseLimit is above signal price', () => {
    const profile: ChaseProfile = { pctPerStep: 0.04, minStep: 0.02, maxStep: 0.25, maxSlippagePct: 0.50, intervalSec: 5 };
    const result = resolveChaseParams(profile, 2.00, true);
    // chaseLimit = 2.00 * 1.50 = 3.00
    expect(result.chaseLimit).toBe(3.00);
  });

  test('SELL chaseLimit is below signal price', () => {
    const profile: ChaseProfile = { pctPerStep: 0.04, minStep: 0.02, maxStep: 0.25, maxSlippagePct: 0.50, intervalSec: 5 };
    const result = resolveChaseParams(profile, 2.00, false);
    // chaseLimit = 2.00 * 0.50 = 1.00
    expect(result.chaseLimit).toBe(1.00);
  });

  test('SELL chaseLimit never goes below $0.01', () => {
    const profile: ChaseProfile = { pctPerStep: 0.05, minStep: 0.01, maxStep: 0.30, maxSlippagePct: 0.99, intervalSec: 5 };
    // signalPrice = $0.05 → chaseLimit = 0.05 * 0.01 = 0.0005 → clamped to 0.01
    const result = resolveChaseParams(profile, 0.05, false);
    expect(result.chaseLimit).toBe(0.01);
  });

  test('maxSteps = floor(chaseRange / stepAmount), min 1', () => {
    const profile: ChaseProfile = { pctPerStep: 0.04, minStep: 0.02, maxStep: 0.25, maxSlippagePct: 0.50, intervalSec: 5 };
    // signalPrice = $2.00, isBuy
    // stepAmount = roundCents(0.08) = 0.08
    // chaseLimit = 3.00
    // chaseRange = 1.00
    // maxSteps = floor(1.00 / 0.08) = 12
    const result = resolveChaseParams(profile, 2.00, true);
    expect(result.stepAmount).toBe(0.08);
    expect(result.chaseLimit).toBe(3.00);
    expect(result.maxSteps).toBe(12);
  });

  test('maxSteps is always at least 1', () => {
    // Very tight slippage + large step → range < stepAmount → maxSteps = 1
    const profile: ChaseProfile = { pctPerStep: 0, minStep: 10.00, maxStep: 10.00, maxSlippagePct: 0.001, intervalSec: 5 };
    const result = resolveChaseParams(profile, 100, true);
    // chaseRange = 100 * 0.001 = 0.10, step = 10 → floor(0.10/10) = 0 → clamped to 1
    expect(result.maxSteps).toBe(1);
  });

  test('cancelAfterSec passes through from profile', () => {
    const profile: ChaseProfile = { pctPerStep: 0.04, minStep: 0.02, maxStep: 0.25, maxSlippagePct: 0.50, intervalSec: 5, cancelAfterSec: 45 };
    const result = resolveChaseParams(profile, 2.00, true);
    expect(result.cancelAfterSec).toBe(45);
  });

  test('cancelAfterSec is undefined when profile omits it', () => {
    const profile: ChaseProfile = { pctPerStep: 0.04, minStep: 0.02, maxStep: 0.25, maxSlippagePct: 0.50, intervalSec: 5 };
    const result = resolveChaseParams(profile, 2.00, true);
    expect(result.cancelAfterSec).toBeUndefined();
  });

  test('STOCK_OPEN profile produces fixed step of $0.03', () => {
    // pctPerStep=0, minStep=0.03, maxStep=0.03 → always $0.03
    const result = resolveChaseParams(CHASE_PROFILES.STOCK_OPEN, 150.00, true);
    expect(result.stepAmount).toBe(0.03);
    expect(result.cancelAfterSec).toBe(60);
  });

  test('STOCK_CLOSE profile produces fixed step of $0.05 with no cancel', () => {
    const result = resolveChaseParams(CHASE_PROFILES.STOCK_CLOSE, 150.00, false);
    expect(result.stepAmount).toBe(0.05);
    expect(result.cancelAfterSec).toBeUndefined();
  });

  test('all values are rounded to cents', () => {
    // Use a price that produces irrational results
    const profile: ChaseProfile = { pctPerStep: 0.03, minStep: 0.01, maxStep: 0.50, maxSlippagePct: 0.33, intervalSec: 5 };
    const result = resolveChaseParams(profile, 3.33, true);
    expect(result.stepAmount).toBe(roundCents(result.stepAmount));
    expect(result.chaseLimit).toBe(roundCents(result.chaseLimit));
  });
});

describe('selectChaseProfile', () => {
  const cases: Array<{ strategy: Strategy; isPositionReducing: boolean; isBuy: boolean; expected: string }> = [
    { strategy: 'STOCK', isPositionReducing: false, isBuy: true,  expected: 'STOCK_OPEN' },
    { strategy: 'STOCK', isPositionReducing: true,  isBuy: false, expected: 'STOCK_CLOSE' },
    { strategy: 'CALL',  isPositionReducing: false, isBuy: true,  expected: 'OPTION_OPEN_BUY' },
    { strategy: 'CALL',  isPositionReducing: false, isBuy: false, expected: 'OPTION_OPEN_SELL' },
    { strategy: 'PUT',   isPositionReducing: false, isBuy: true,  expected: 'OPTION_OPEN_BUY' },
    { strategy: 'PUT',   isPositionReducing: false, isBuy: false, expected: 'OPTION_OPEN_SELL' },
    { strategy: 'CALL',  isPositionReducing: true,  isBuy: false, expected: 'OPTION_CLOSE' },
    { strategy: 'PUT',   isPositionReducing: true,  isBuy: true,  expected: 'OPTION_CLOSE' },
    { strategy: 'CDS',   isPositionReducing: false, isBuy: true,  expected: 'SPREAD_OPEN_BUY' },
    { strategy: 'CDS',   isPositionReducing: false, isBuy: false, expected: 'SPREAD_OPEN_SELL' },
    { strategy: 'PDS',   isPositionReducing: false, isBuy: true,  expected: 'SPREAD_OPEN_BUY' },
    { strategy: 'PDS',   isPositionReducing: false, isBuy: false, expected: 'SPREAD_OPEN_SELL' },
    { strategy: 'PCS',   isPositionReducing: false, isBuy: true,  expected: 'SPREAD_OPEN_BUY' },
    { strategy: 'CDS',   isPositionReducing: true,  isBuy: false, expected: 'SPREAD_CLOSE' },
    { strategy: 'PDS',   isPositionReducing: true,  isBuy: true,  expected: 'SPREAD_CLOSE' },
  ];

  for (const { strategy, isPositionReducing, isBuy, expected } of cases) {
    const label = `${strategy} ${isPositionReducing ? 'CLOSE' : 'OPEN'} ${isBuy ? 'BUY' : 'SELL'} -> ${expected}`;
    test(label, () => {
      const profile = selectChaseProfile(strategy, isPositionReducing, isBuy);
      const expectedProfile = CHASE_PROFILES[expected as keyof typeof CHASE_PROFILES];
      expect(profile).toEqual(expectedProfile);
    });
  }

  test('close orders never have cancelAfterSec', () => {
    for (const strategy of ['CALL', 'PUT', 'CDS', 'PDS', 'STOCK'] as Strategy[]) {
      const profile = selectChaseProfile(strategy, true, false);
      expect(profile.cancelAfterSec).toBeUndefined();
    }
  });

  test('open orders always have cancelAfterSec', () => {
    for (const strategy of ['CALL', 'PUT', 'CDS', 'PDS', 'STOCK'] as Strategy[]) {
      const profile = selectChaseProfile(strategy, false, true);
      expect(profile.cancelAfterSec).toBeDefined();
      expect(profile.cancelAfterSec).toBeGreaterThan(0);
    }
  });
});
