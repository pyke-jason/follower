import { describe, expect, test } from 'vitest';
import { CriticVerdictSchema } from './schemas.js';

describe('CriticVerdictSchema', () => {
  test('accepts bounded critic findings', () => {
    const parsed = CriticVerdictSchema.parse({
      verdict: 'critical',
      summary: 'Wrong close target.',
      findings: [{
        category: 'profit_loss_mismatch',
        severity: 'critical',
        message: 'P&L does not match trader language.',
        evidence: 'message says profit; recorded pnl=-42',
        confidence: 0.91,
      }],
    });

    expect(parsed.verdict).toBe('critical');
  });

  test('rejects malformed critic output before persistence', () => {
    expect(() => CriticVerdictSchema.parse({
      verdict: 'panic',
      summary: '',
      findings: [{
        category: 'unknown',
        severity: 'critical',
        message: '',
        evidence: '',
        confidence: 2,
      }],
    })).toThrow();
  });
});
