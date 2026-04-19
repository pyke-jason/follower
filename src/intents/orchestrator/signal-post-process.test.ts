import { describe, expect, it } from 'vitest';
import { postProcessSignals } from './signal-post-process.js';
import type { Signal } from '@/agent/schemas.js';

const base: Signal = {
  action: 'OPEN', symbol: 'XYZ', direction: null, strategy: null,
  strikes: null, expiry: null, statedPrice: null, quantity: null,
};

describe('postProcessSignals', () => {
  describe('rule_dollarPriceImpliesStock', () => {
    it('fills strategy=STOCK when $ price and no option markers', () => {
      const out = postProcessSignals(
        [{ ...base, statedPrice: 18.51 }],
        'Exit Long OSCR @ $18.51 for penny gain.',
      );
      expect(out[0].strategy).toBe('STOCK');
    });

    it('leaves strategy alone when option word present', () => {
      const out = postProcessSignals(
        [{ ...base, statedPrice: 2.03 }],
        'Long NVDA 175c 9/26 2.03 calls',
      );
      expect(out[0].strategy).toBe(null); // would be filled by other rules, but NOT by this one
    });

    it('respects existing strategy', () => {
      const out = postProcessSignals(
        [{ ...base, statedPrice: 18.51, strategy: 'CALL' }],
        'Long OSCR @ $18.51',
      );
      expect(out[0].strategy).toBe('CALL');
    });
  });

  describe('rule_partialExitIsTrim', () => {
    it('CLOSE → TRIM on "took more gains"', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'CLOSE' }],
        'Exit Short C took more gains $1.00.',
      );
      expect(out[0].action).toBe('TRIM');
      expect(out[0].exitPercent).toBe(0.5);
    });

    it('CLOSE → TRIM on "took partial profits"', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'CLOSE' }],
        'Exit Long OPEN took partial profits in shares',
      );
      expect(out[0].action).toBe('TRIM');
    });

    it('CLOSE stays CLOSE on "remainder"', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'CLOSE' }],
        'Exit HCA remainder of position at $414.40',
      );
      expect(out[0].action).toBe('CLOSE');
    });

    it('CLOSE stays CLOSE on "all out"', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'CLOSE' }],
        'Exit AAPL all out at 255',
      );
      expect(out[0].action).toBe('CLOSE');
    });
  });

  describe('rule_strip_pl_miscoded_as_exitpct', () => {
    it('strips exitPercent when "50% profit" is the only % ref', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'CLOSE', exitPercent: 0.5 }],
        'Exit Short LULU took profits in pds 50% profit',
      );
      expect(out[0].exitPercent).toBeUndefined();
    });

    it('keeps exitPercent when explicit partial also present', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'TRIM', exitPercent: 0.5 }],
        'Exit Long OPEN took partial profits 50% profit',
      );
      expect(out[0].exitPercent).toBe(0.5);
    });

    it('strips exitPercent on OPEN action always', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'OPEN', exitPercent: 0.5 }],
        'Long AAPL 250 stock',
      );
      expect(out[0].exitPercent).toBeUndefined();
    });
  });

  describe('rule_covered_short_direction', () => {
    it('SHORT direction on "covered stock i shorted"', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'CLOSE', strategy: 'STOCK', direction: null }],
        'Exit Long GOOGL took profits in calls (covered stock i shorted after hours yesterday)',
      );
      expect(out[0].direction).toBe('SHORT');
    });
  });

  describe('rule_my_long_position_direction', () => {
    it('LONG on "Exit OPEN remainder of my shares"', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'CLOSE', strategy: 'STOCK', direction: null }],
        'Exit OPEN remainder of my shares for nice profit',
      );
      expect(out[0].direction).toBe('LONG');
    });
  });

  describe('rule_my_options_direction', () => {
    it('"my calls" → CALL + LONG', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'TRIM', strategy: null, direction: null }],
        'Exit Long UNH took additional profits in my calls still holding',
      );
      expect(out[0].strategy).toBe('CALL');
      expect(out[0].direction).toBe('LONG');
    });
  });

  describe('rule_overnight_expiry', () => {
    it('fills expiry="overnight" when text says "for overnight"', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'OPEN', strategy: 'STOCK', direction: 'LONG' }],
        'Long SPY for overnight',
      );
      expect(out[0].expiry).toBe('overnight');
    });

    it('respects existing expiry', () => {
      const out = postProcessSignals(
        [{ ...base, expiry: '10/17' }],
        'Long SPY 10/17 overnight',
      );
      expect(out[0].expiry).toBe('10/17');
    });
  });

  describe('rule_strip_phantom_quantity', () => {
    it('strips quantity when no shares/contracts word', () => {
      const out = postProcessSignals(
        [{ ...base, quantity: 0.5 }],
        'Long QS via selling the Sept (19) $9.50 puts @ $.50',
      );
      expect(out[0].quantity).toBe(null);
    });

    it('keeps quantity when "contract" or "shares" present', () => {
      const out = postProcessSignals(
        [{ ...base, quantity: 1 }],
        'Long JOBY sold Oct (10) $15 put @ $.60. I only did one contract.',
      );
      expect(out[0].quantity).toBe(1);
    });
  });

  describe('rule_strip_pl_miscoded_as_price', () => {
    it('strips statedPrice when it matches a P&L amount and no prior price', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'CLOSE', statedPrice: 0.17 }],
        'Exit Long AGH .17 gain',
      );
      expect(out[0].statedPrice).toBe(null);
    });

    it('keeps statedPrice when an @ price precedes the P&L phrase', () => {
      const out = postProcessSignals(
        [{ ...base, action: 'CLOSE', statedPrice: 81.63 }],
        'Exit Long OKLO $81.63 (got stopped out for $1 profit)',
      );
      expect(out[0].statedPrice).toBe(81.63);
    });
  });
});
