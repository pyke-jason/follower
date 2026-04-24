import { describe, expect, it } from 'vitest';
import { matchCanonicalTrade } from './canonical-trade.js';

describe('matchCanonicalTrade — whole-message templates only', () => {
  describe('STOCK', () => {
    it('bare price: "Long NVDA 182.38"', () => {
      const r = matchCanonicalTrade('Long NVDA 182.38', 'NVDA', 'OPEN');
      expect(r).toEqual({
        action: 'OPEN', direction: null, strategy: 'STOCK',
        strikes: null, expiry: null, statedPrice: 182.38, exitPercent: null,
        ruleId: 'canonical.stock-bare-price', routeReason: 'STOCK bare price',
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
        strikes: [175], expiry: '12/21', statedPrice: null, exitPercent: null,
        ruleId: 'canonical.opt-strike-type-mmdd', routeReason: 'OPT strike+type+MMDD',
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

  describe('EXIT STOCK with structured price prose', () => {
    it('"at $price final sell with profit": "Exit WMT at $103.22 final sell with profit."', () => {
      const r = matchCanonicalTrade('Exit WMT at $103.22 final sell with profit.', 'WMT', 'CLOSE');
      expect(r?.strategy).toBe('STOCK');
      expect(r?.action).toBe('CLOSE');
      expect(r?.statedPrice).toBe(103.22);
    });
    it('"with profit at $price": "Exit GE with profit at $283.03"', () => {
      const r = matchCanonicalTrade('Exit GE with profit at $283.03', 'GE', 'CLOSE');
      expect(r?.strategy).toBe('STOCK');
      expect(r?.action).toBe('CLOSE');
      expect(r?.statedPrice).toBe(283.03);
    });
    it('"with a loss at $price": "Exit ALAB with a loss at $114.00"', () => {
      const r = matchCanonicalTrade('Exit ALAB with a loss at $114.00', 'ALAB', 'CLOSE');
      expect(r?.strategy).toBe('STOCK');
      expect(r?.statedPrice).toBe(114);
    });
  });

  describe('TRIM STOCK partial-exit patterns', () => {
    it('"$price half of the position for $gain": "Exit Long IREN $48.40 half of the position for $1.30 gain."', () => {
      const r = matchCanonicalTrade('Exit Long IREN $48.40 half of the position for $1.30 gain.', 'IREN', 'CLOSE');
      expect(r?.action).toBe('TRIM');
      expect(r?.strategy).toBe('STOCK');
      expect(r?.statedPrice).toBe(48.40);
      expect(r?.exitPercent).toBe(0.5);
    });
    it('"partial profits $price": "Exit MSFT partial profits $499 (stop at entry on remaining)"', () => {
      const r = matchCanonicalTrade('Exit MSFT partial profits $499 (stop at entry on remaining)', 'MSFT', 'CLOSE');
      expect(r?.action).toBe('TRIM');
      expect(r?.strategy).toBe('STOCK');
      expect(r?.statedPrice).toBe(499);
      expect(r?.exitPercent).toBe(0.5);
    });
    it('"half position at price": "Exit Short UPS half position at 106.26"', () => {
      const r = matchCanonicalTrade('Exit Short UPS half position at 106.26', 'UPS', 'CLOSE');
      expect(r?.action).toBe('TRIM');
      expect(r?.statedPrice).toBe(106.26);
      expect(r?.exitPercent).toBe(0.5);
    });
    it('rejects partial-exit template for OPEN action (not a CLOSE/TRIM)', () => {
      const r = matchCanonicalTrade('Long IREN $48.40 half of the position', 'IREN', 'OPEN');
      expect(r).toBe(null);
    });
  });

  describe('SPREADS extended', () => {
    it('pcs with leading-dot price and credit: "Long GLW pcs 68/67 for .63 credit"', () => {
      const r = matchCanonicalTrade('Long GLW pcs 68/67 for .63 credit', 'GLW', 'OPEN');
      expect(r?.strategy).toBe('PCS');
      expect(r?.direction).toBe('LONG');
      expect(r?.strikes).toEqual([67, 68]);
      expect(r?.statedPrice).toBe(0.63);
    });
    it('pcs with expiring M-D suffix: "Long UNH pcs 330/327.5 for .52 credit expiring 9-19"', () => {
      const r = matchCanonicalTrade('Long UNH pcs 330/327.5 for .52 credit expiring 9-19', 'UNH', 'OPEN');
      expect(r?.strategy).toBe('PCS');
      expect(r?.strikes).toEqual([327.5, 330]);
      expect(r?.expiry).toBe('09/19');
      expect(r?.statedPrice).toBe(0.52);
    });
    it('pds with leading-dot price no credit/debit suffix: "Short GNRC pds 175/172.5 for .88"', () => {
      const r = matchCanonicalTrade('Short GNRC pds 175/172.5 for .88', 'GNRC', 'OPEN');
      expect(r?.strategy).toBe('PDS');
      expect(r?.direction).toBe('SHORT');
      expect(r?.strikes).toEqual([172.5, 175]);
      expect(r?.statedPrice).toBe(0.88);
    });
    it('CDS with bare $price no "for": "Long ORCL CDS $320/$325 $2.00"', () => {
      const r = matchCanonicalTrade('Long ORCL CDS $320/$325 $2.00', 'ORCL', 'OPEN');
      expect(r?.strategy).toBe('CDS');
      expect(r?.direction).toBe('LONG');
      expect(r?.strikes).toEqual([320, 325]);
      expect(r?.statedPrice).toBe(2.00);
    });
    it('rejects commentary-only PCS mention: "Long AMD these PCSes look good today"', () => {
      const r = matchCanonicalTrade('Long AMD these PCSes look good today', 'AMD', 'OPEN');
      expect(r).toBe(null);
    });
  });

  describe('OPTIONS single-leg $strike word form', () => {
    it('"$strike calls for price": "Long CENX $27 calls for .95"', () => {
      const r = matchCanonicalTrade('Long CENX $27 calls for .95', 'CENX', 'OPEN');
      expect(r?.strategy).toBe('CALL');
      expect(r?.strikes).toEqual([27]);
      expect(r?.statedPrice).toBe(0.95);
    });
    it('strips "again" commentary: "Long CENX $27 calls again for .93"', () => {
      const r = matchCanonicalTrade('Long CENX $27 calls again for .93', 'CENX', 'OPEN');
      expect(r?.strategy).toBe('CALL');
      expect(r?.strikes).toEqual([27]);
      expect(r?.statedPrice).toBe(0.93);
    });
    it('strips "basically intrinsic" trailer: "Long CENX lotto $27 calls for .95 basically intrinsic"', () => {
      const r = matchCanonicalTrade('Long CENX lotto $27 calls for .95 basically intrinsic', 'CENX', 'OPEN');
      expect(r?.strategy).toBe('CALL');
      expect(r?.strikes).toEqual([27]);
      expect(r?.statedPrice).toBe(0.95);
    });
    it('"Lotto $strike Calls for price - N Contracts": "Long AVGO Lotto $340 Calls for .48 - 5 Contracts"', () => {
      const r = matchCanonicalTrade('Long AVGO Lotto $340 Calls for .48 - 5 Contracts', 'AVGO', 'OPEN');
      expect(r?.strategy).toBe('CALL');
      expect(r?.strikes).toEqual([340]);
      expect(r?.statedPrice).toBe(0.48);
    });
    it('with MMDD expiry: "Long SKM $35 Calls 3/20 for .71 - 7 Contracts (and I still have the $40 Calls)"', () => {
      const r = matchCanonicalTrade('Long SKM $35 Calls 3/20 for .71 - 7 Contracts (and I still have the $40 Calls)', 'SKM', 'OPEN');
      expect(r?.strategy).toBe('CALL');
      expect(r?.strikes).toEqual([35]);
      expect(r?.expiry).toBe('03/20');
      expect(r?.statedPrice).toBe(0.71);
    });
    it('rejects on free prose trailer: "Long MSFT $400 Calls for $12.05 - 2 Contracts - I was wavering"', () => {
      const r = matchCanonicalTrade('Long MSFT $400 Calls for $12.05 - 2 Contracts - I was wavering', 'MSFT', 'OPEN');
      expect(r).toBe(null);
    });
  });

  describe('OPTIONS sell-to-open (direction=SHORT)', () => {
    it('"sold MonthName (D) $strike put @ $price": "Long JOBY sold Oct (10) $15 put @ $.60"', () => {
      const r = matchCanonicalTrade('Long JOBY sold Oct (10) $15 put @ $.60', 'JOBY', 'OPEN');
      expect(r?.action).toBe('OPEN');
      expect(r?.direction).toBe('SHORT');
      expect(r?.strategy).toBe('PUT');
      expect(r?.strikes).toEqual([15]);
      expect(r?.expiry).toBe('10/10');
      expect(r?.statedPrice).toBe(0.60);
    });
    it('"via selling the MonthName (D) $strike puts @ $price": "Long QS via selling the Sept (19) $9.50 puts @ $.50"', () => {
      const r = matchCanonicalTrade('Long QS via selling the Sept (19) $9.50 puts @ $.50', 'QS', 'OPEN');
      expect(r?.direction).toBe('SHORT');
      expect(r?.strategy).toBe('PUT');
      expect(r?.strikes).toEqual([9.5]);
      expect(r?.expiry).toBe('09/19');
      expect(r?.statedPrice).toBe(0.50);
    });
    it('"sold MonthName (D) $strike put $price" (no @/for): "Long BE sold Oct (17) $59 put $ 2.40"', () => {
      const r = matchCanonicalTrade('Long BE sold Oct (17) $59 put $ 2.40', 'BE', 'OPEN');
      expect(r?.direction).toBe('SHORT');
      expect(r?.strategy).toBe('PUT');
      expect(r?.strikes).toEqual([59]);
      expect(r?.expiry).toBe('10/17');
      expect(r?.statedPrice).toBe(2.40);
    });
    it('"sold the MM/DD $strike put for $price/contract": "Long MP sold the 03/13 $57 puts for $1.03/contract"', () => {
      const r = matchCanonicalTrade('Long MP sold the 03/13 $57 puts for $1.03/contract', 'MP', 'OPEN');
      expect(r?.direction).toBe('SHORT');
      expect(r?.strategy).toBe('PUT');
      expect(r?.strikes).toEqual([57]);
      expect(r?.expiry).toBe('03/13');
      expect(r?.statedPrice).toBe(1.03);
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
    it('half-position with free-prose trailer: "Exit Short UPS half position at 106.26 - realised ..."', () => {
      const r = matchCanonicalTrade('Exit Short UPS half position at 106.26 - realised that my sizing was too big', 'UPS', 'CLOSE');
      expect(r).toBe(null);
    });
    it('$N calls with free-prose trailer: "Long MSFT $400 Calls for $12.05 - 2 Contracts - I was wavering"', () => {
      const r = matchCanonicalTrade('Long MSFT $400 Calls for $12.05 - 2 Contracts - I was wavering', 'MSFT', 'OPEN');
      expect(r).toBe(null);
    });
  });
});
