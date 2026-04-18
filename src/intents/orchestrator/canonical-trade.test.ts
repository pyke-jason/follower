import { describe, expect, it } from 'vitest';
import { matchCanonicalTrade } from './canonical-trade.js';

describe('matchCanonicalTrade — whole-message templates only', () => {
  describe('STOCK', () => {
    it('bare price: "Long NVDA 182.38"', () => {
      const r = matchCanonicalTrade('Long NVDA 182.38', 'NVDA', 'OPEN');
      expect(r).toEqual({
        action: 'OPEN', direction: null, strategy: 'STOCK',
        strikes: null, expiry: null, statedPrice: 182.38,
      });
    });
    it('@ price: "Short VXX @ 34.20"', () => {
      const r = matchCanonicalTrade('Short VXX @ 34.20', 'VXX', 'OPEN');
      expect(r?.strategy).toBe('STOCK');
      expect(r?.statedPrice).toBe(34.20);
    });
    it('at $price: "Short SHOO at $32.03"', () => {
      const r = matchCanonicalTrade('Short SHOO at $32.03', 'SHOO', 'OPEN');
      expect(r?.strategy).toBe('STOCK');
      expect(r?.statedPrice).toBe(32.03);
    });
    it('dollar price: "Long VRT $260.76"', () => {
      const r = matchCanonicalTrade('Long VRT $260.76', 'VRT', 'OPEN');
      expect(r?.statedPrice).toBe(260.76);
    });
    it('strips paren comment: "Long NVDA 179.24 (2nd try)"', () => {
      const r = matchCanonicalTrade('Long NVDA 179.24 (2nd try)', 'NVDA', 'OPEN');
      expect(r?.strategy).toBe('STOCK');
      expect(r?.statedPrice).toBe(179.24);
    });
    it('strips P&L annotation: "Short Exit CRM 197.58 (-53c loss)"', () => {
      const r = matchCanonicalTrade('Short Exit CRM 197.58 (-53c loss)', 'CRM', 'CLOSE');
      expect(r?.strategy).toBe('STOCK');
      expect(r?.statedPrice).toBe(197.58);
    });
  });

  describe('OPTIONS (single leg)', () => {
    it('strike+type+MMDD: "Long NVDA 175c 12/21"', () => {
      const r = matchCanonicalTrade('Long NVDA 175c 12/21', 'NVDA', 'OPEN');
      expect(r).toEqual({
        action: 'OPEN', direction: null, strategy: 'CALL',
        strikes: [175], expiry: '12/21', statedPrice: null,
      });
    });
    it('strike+type+MMDD+price: "Long NVDA 175c 9/26 2.03"', () => {
      const r = matchCanonicalTrade('Long NVDA 175c 9/26 2.03', 'NVDA', 'OPEN');
      expect(r?.strategy).toBe('CALL');
      expect(r?.strikes).toEqual([175]);
      expect(r?.expiry).toBe('09/26');
      expect(r?.statedPrice).toBe(2.03);
    });
    it('put with @ price: "Short AMD 155p 10/3 @ 2.10"', () => {
      const r = matchCanonicalTrade('Short AMD 155p 10/3 @ 2.10', 'AMD', 'OPEN');
      expect(r?.strategy).toBe('PUT');
      expect(r?.strikes).toEqual([155]);
      expect(r?.statedPrice).toBe(2.10);
    });
  });

  describe('SPREADS', () => {
    it('cds whole-message: "Long UNH cds 330/340 for $0.52"', () => {
      const r = matchCanonicalTrade('Long UNH cds 330/340 for $0.52', 'UNH', 'OPEN');
      expect(r?.strategy).toBe('CDS');
      expect(r?.direction).toBe('LONG');
      expect(r?.strikes).toEqual([330, 340]);
      expect(r?.statedPrice).toBe(0.52);
    });
    it('pds whole-message with "credit" suffix: "Short UPS pds 84/83 for $0.33 credit"', () => {
      const r = matchCanonicalTrade('Short UPS pds 84/83 for $0.33 credit', 'UPS', 'OPEN');
      expect(r?.strategy).toBe('PDS');
      expect(r?.direction).toBe('SHORT');
    });
  });

  describe('returns null for non-canonical messages', () => {
    it('prose that mentions PDS: "these PDSes look good today"', () => {
      const r = matchCanonicalTrade('Long AMD these PDSes look good today', 'AMD', 'OPEN');
      expect(r).toBe(null);
    });
    it('bare ticker: "Long NVDA"', () => {
      const r = matchCanonicalTrade('Long NVDA', 'NVDA', 'OPEN');
      expect(r).toBe(null);
    });
    it('long prose: "Exit Long AA WATM rolled my $32 weekly put to next week for .60 credit"', () => {
      const r = matchCanonicalTrade(
        'Exit Long AA WATM rolled my $32 weekly put to next week for .60 credit',
        'AA', 'CLOSE',
      );
      expect(r).toBe(null);
    });
    it('setup announcement: "UNHLong calls 337s vs 340s will start taking Pts"', () => {
      const r = matchCanonicalTrade('UNHLong calls 337s vs 340s will start taking Pts', 'UNH', 'OPEN');
      expect(r).toBe(null);
    });
  });
});
