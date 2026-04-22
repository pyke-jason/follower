import { describe, test, expect } from 'vitest';
import { buildComboOrderBody } from './client.js';
import type { OrderLeg, OrderParams } from '../types.js';

function putLeg(strike: number, action: 'BUY' | 'SELL', expiry = '20260515'): OrderLeg {
  return {
    symbol: `ASTS_${expiry}_P${strike}`,
    strike,
    expiry,
    type: 'PUT',
    action,
    quantity: 1,
  };
}

function callLeg(strike: number, action: 'BUY' | 'SELL', expiry = '20260515'): OrderLeg {
  return {
    symbol: `ASTS_${expiry}_C${strike}`,
    strike,
    expiry,
    type: 'CALL',
    action,
    quantity: 1,
  };
}

function baseParams(legs: OrderLeg[], direction: 'LONG' | 'SHORT', isClosing = false): OrderParams {
  return {
    symbol: 'ASTS',
    strategy: 'PCS',
    direction,
    legs,
    orderType: 'LIMIT',
    isClosing,
    limitPrice: 0.7,
  };
}

function resolvedLegs(legs: OrderLeg[]): Array<{ leg: OrderLeg; conId: number }> {
  return legs.map((leg, i) => ({ leg, conId: 100 + i }));
}

describe('buildComboOrderBody — PCS riskless-rejection fix', () => {
  test('PCS OPEN: legs are [SELL hi PUT, BUY lo PUT], parent BUY, limit negative (credit)', () => {
    const legs = [putLeg(72, 'SELL'), putLeg(69, 'BUY')];
    const body = buildComboOrderBody({
      symbol: 'ASTS',
      resolvedLegs: resolvedLegs(legs),
      params: baseParams(legs, 'SHORT'),
      limitPrice: 0.7,
      clientOrderRef: 'test-ref',
    });

    expect(body.action).toBe('BUY');
    expect(body.limitPrice).toBe(-0.7);
    const bodyLegs = body.legs as Array<{ action: string; conId: number }>;
    expect(bodyLegs[0].action).toBe('SELL');
    expect(bodyLegs[1].action).toBe('BUY');
  });

  test('PCS CLOSE: legs are [BUY hi PUT, SELL lo PUT], parent BUY, limit positive (debit to close)', () => {
    const legs = [putLeg(72, 'BUY'), putLeg(69, 'SELL')];
    const body = buildComboOrderBody({
      symbol: 'ASTS',
      resolvedLegs: resolvedLegs(legs),
      params: baseParams(legs, 'LONG', true),
      limitPrice: 0.4,
      clientOrderRef: 'test-ref',
    });

    expect(body.action).toBe('BUY');
    expect(body.limitPrice).toBe(0.4);
    const bodyLegs = body.legs as Array<{ action: string; conId: number }>;
    expect(bodyLegs[0].action).toBe('BUY');
    expect(bodyLegs[1].action).toBe('SELL');
  });

  test('PDS OPEN: debit spread, parent BUY, limit positive', () => {
    const legs = [putLeg(72, 'BUY'), putLeg(69, 'SELL')];
    const body = buildComboOrderBody({
      symbol: 'ASTS',
      resolvedLegs: resolvedLegs(legs),
      params: { ...baseParams(legs, 'LONG'), strategy: 'PDS' },
      limitPrice: 1.2,
      clientOrderRef: 'test-ref',
    });

    expect(body.action).toBe('BUY');
    expect(body.limitPrice).toBe(1.2);
  });

  test('CDS OPEN: legs are [BUY lo CALL, SELL hi CALL], parent BUY, limit positive (debit)', () => {
    const legs = [callLeg(100, 'BUY'), callLeg(105, 'SELL')];
    const body = buildComboOrderBody({
      symbol: 'ASTS',
      resolvedLegs: resolvedLegs(legs),
      params: { ...baseParams(legs, 'LONG'), strategy: 'CDS' },
      limitPrice: 1.5,
      clientOrderRef: 'test-ref',
    });

    expect(body.action).toBe('BUY');
    expect(body.limitPrice).toBe(1.5);
    const bodyLegs = body.legs as Array<{ action: string; conId: number }>;
    expect(bodyLegs[0].action).toBe('BUY');
    expect(bodyLegs[1].action).toBe('SELL');
  });

  test('CCS OPEN: legs are [SELL lo CALL, BUY hi CALL], parent BUY, limit negative (credit)', () => {
    const legs = [callLeg(100, 'SELL'), callLeg(105, 'BUY')];
    const body = buildComboOrderBody({
      symbol: 'ASTS',
      resolvedLegs: resolvedLegs(legs),
      params: { ...baseParams(legs, 'SHORT'), strategy: 'CCS' },
      limitPrice: 0.5,
      clientOrderRef: 'test-ref',
    });

    expect(body.action).toBe('BUY');
    expect(body.limitPrice).toBe(-0.5);
    const bodyLegs = body.legs as Array<{ action: string; conId: number }>;
    expect(bodyLegs[0].action).toBe('SELL');
    expect(bodyLegs[1].action).toBe('BUY');
  });

  test('parent action is never SELL — avoids TWS leg-inversion that triggers riskless rejection', () => {
    const cases = [
      [putLeg(72, 'SELL'), putLeg(69, 'BUY')],     // PCS
      [putLeg(72, 'BUY'),  putLeg(69, 'SELL')],    // PDS
      [callLeg(100, 'BUY'), callLeg(105, 'SELL')], // CDS
      [callLeg(100, 'SELL'), callLeg(105, 'BUY')], // CCS
    ] as const;
    for (const legs of cases) {
      const body = buildComboOrderBody({
        symbol: 'ASTS',
        resolvedLegs: resolvedLegs([...legs]),
        params: baseParams([...legs], 'LONG'),
        limitPrice: 1,
        clientOrderRef: 'test-ref',
      });
      expect(body.action).toBe('BUY');
    }
  });

  test('ratio is 1 for every leg (equal-width verticals)', () => {
    const legs = [putLeg(72, 'SELL'), putLeg(69, 'BUY')];
    const body = buildComboOrderBody({
      symbol: 'ASTS',
      resolvedLegs: resolvedLegs(legs),
      params: baseParams(legs, 'SHORT'),
      limitPrice: 0.7,
      clientOrderRef: 'test-ref',
    });
    const bodyLegs = body.legs as Array<{ ratio: number }>;
    for (const l of bodyLegs) expect(l.ratio).toBe(1);
  });

  test('omits limitPrice when not provided (MKT combo)', () => {
    const legs = [putLeg(72, 'SELL'), putLeg(69, 'BUY')];
    const body = buildComboOrderBody({
      symbol: 'ASTS',
      resolvedLegs: resolvedLegs(legs),
      params: { ...baseParams(legs, 'SHORT'), orderType: 'MARKET' },
      limitPrice: undefined,
      clientOrderRef: 'test-ref',
    });
    expect(body.limitPrice).toBeUndefined();
    expect(body.orderType).toBe('MKT');
  });
});
