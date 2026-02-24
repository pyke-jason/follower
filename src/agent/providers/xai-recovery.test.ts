/**
 * Tests for text-to-tool-call recovery in the XAI provider.
 *
 * Pure functions — no API calls, no DB.
 */

import { describe, test, expect } from 'vitest';
import { _testing } from './xai.js';

const { recoverToolCallsFromText, extractReasoning, parseSignalText, parseLegsText } = _testing;

// ── recoverToolCallsFromText ─────────────────────────────────────────

describe('recoverToolCallsFromText', () => {
  test('recovers submit_decision(EXECUTE) with signal fields', () => {
    const text = `<reasoning>The trader is closing the short puts on MSFT PDS.</reasoning>
submit_decision(EXECUTE): action CLOSE, symbol MSFT, strategy PDS`;
    const calls = recoverToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('submit_decision');
    expect(calls[0].input).toMatchObject({
      decision: 'EXECUTE',
      signals: [{ action: 'CLOSE', symbol: 'MSFT', strategy: 'PDS' }],
    });
    expect(calls[0].input.reasoning).toContain('closing the short puts');
  });

  test('recovers submit_decision(SKIP)', () => {
    const text = `<reasoning>Not a trade signal.</reasoning>
submit_decision(SKIP)`;
    const calls = recoverToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('submit_decision');
    expect(calls[0].input).toMatchObject({ decision: 'SKIP' });
    expect(calls[0].input.reasoning).toContain('Not a trade signal');
  });

  test('recovers submit_decision(MANUAL_REVIEW)', () => {
    const text = 'submit_decision(MANUAL_REVIEW): unclear';
    const calls = recoverToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({ decision: 'MANUAL_REVIEW' });
  });

  test('recovers flag_for_review', () => {
    const text = 'flag_for_review("Ambiguous trade direction")';
    const calls = recoverToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('flag_for_review');
    expect(calls[0].input).toMatchObject({ reason: 'Ambiguous trade direction' });
  });

  test('recovers flag_for_review with colon syntax', () => {
    const text = 'flag_for_review: Multiple possible interpretations';
    const calls = recoverToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({ reason: 'Multiple possible interpretations' });
  });

  test('returns empty for normal text with no tool patterns', () => {
    const text = 'The trader is discussing MSFT. No action needed.';
    expect(recoverToolCallsFromText(text)).toHaveLength(0);
  });

  test('returns empty for EXECUTE without detail text', () => {
    const text = 'submit_decision(EXECUTE)';
    expect(recoverToolCallsFromText(text)).toHaveLength(0);
  });

  test('returns empty for EXECUTE with unparseable detail', () => {
    const text = 'submit_decision(EXECUTE): just some words';
    expect(recoverToolCallsFromText(text)).toHaveLength(0);
  });

  test('handles case-insensitive match', () => {
    const text = 'Submit_Decision(skip)';
    const calls = recoverToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.decision).toBe('SKIP');
  });

  test('generates unique IDs with recovered- prefix', () => {
    const text = 'submit_decision(SKIP)';
    const calls1 = recoverToolCallsFromText(text);
    const calls2 = recoverToolCallsFromText(text);
    expect(calls1[0].id).toMatch(/^recovered-/);
    expect(calls2[0].id).toMatch(/^recovered-/);
    expect(calls1[0].id).not.toBe(calls2[0].id);
  });

  test('recovers multi-signal array (strangle)', () => {
    const text = `<reasoning>Strangle = two LONG positions.</reasoning>
submit_decision(EXECUTE): [
  action OPEN, symbol SPY, direction LONG, strategy CALL,
  action OPEN, symbol SPY, direction LONG, strategy PUT
]`;
    const calls = recoverToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('submit_decision');
    const input = calls[0].input as { decision: string; signals: Array<Record<string, unknown>> };
    expect(input.decision).toBe('EXECUTE');
    expect(input.signals).toHaveLength(2);
    expect(input.signals[0]).toMatchObject({ action: 'OPEN', symbol: 'SPY', direction: 'LONG', strategy: 'CALL' });
    expect(input.signals[1]).toMatchObject({ action: 'OPEN', symbol: 'SPY', direction: 'LONG', strategy: 'PUT' });
  });

  test('still recovers single signal without brackets', () => {
    const text = 'submit_decision(EXECUTE): action CLOSE, symbol MSFT';
    const calls = recoverToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({
      decision: 'EXECUTE',
      signals: [{ action: 'CLOSE', symbol: 'MSFT' }],
    });
  });
});

// ── extractReasoning ─────────────────────────────────────────────────

describe('extractReasoning', () => {
  test('extracts from reasoning tags', () => {
    const text = '<reasoning>Trader is closing MSFT position.</reasoning>\nsubmit_decision(SKIP)';
    expect(extractReasoning(text)).toBe('Trader is closing MSFT position.');
  });

  test('falls back to first 500 chars when no tags', () => {
    const text = 'No tags here, just plain reasoning about the trade.';
    expect(extractReasoning(text)).toBe(text);
  });

  test('truncates fallback to 500 chars', () => {
    const text = 'x'.repeat(600);
    expect(extractReasoning(text)).toHaveLength(500);
  });
});

// ── parseSignalText ──────────────────────────────────────────────────

describe('parseSignalText', () => {
  test('parses basic CLOSE signal', () => {
    const result = parseSignalText('action CLOSE, symbol MSFT, strategy PDS');
    expect(result).toEqual({ action: 'CLOSE', symbol: 'MSFT', strategy: 'PDS' });
  });

  test('parses OPEN with direction', () => {
    const result = parseSignalText('action OPEN, symbol SPY, direction LONG, strategy CDS');
    expect(result).toEqual({ action: 'OPEN', symbol: 'SPY', direction: 'LONG', strategy: 'CDS' });
  });

  test('parses TRIM with exitPercent', () => {
    const result = parseSignalText('action TRIM, symbol AAPL, exitPercent 0.5');
    expect(result).toEqual({ action: 'TRIM', symbol: 'AAPL', exitPercent: 0.5 });
  });

  test('parses LEG_OFF with targetStrategy', () => {
    const result = parseSignalText('action LEG_OFF, symbol SPY, targetStrategy CALL');
    expect(result).toEqual({ action: 'LEG_OFF', symbol: 'SPY', targetStrategy: 'CALL' });
  });

  test('parses statedPremium', () => {
    const result = parseSignalText('action OPEN, symbol MSFT, statedPremium 2.05');
    expect(result).toMatchObject({ statedPremium: 2.05 });
  });

  test('parses legs inline', () => {
    const result = parseSignalText('action OPEN, symbol MSFT, legs [BUY 507.5P, SELL 500P]');
    expect(result).toMatchObject({
      action: 'OPEN',
      symbol: 'MSFT',
      legs: [
        { action: 'BUY', strike: 507.5, optionType: 'PUT' },
        { action: 'SELL', strike: 500, optionType: 'PUT' },
      ],
    });
  });

  test('returns null when missing action', () => {
    expect(parseSignalText('symbol MSFT, strategy PDS')).toBeNull();
  });

  test('returns null when missing symbol', () => {
    expect(parseSignalText('action CLOSE, strategy PDS')).toBeNull();
  });

  test('uppercases all string fields', () => {
    const result = parseSignalText('action close, symbol msft, strategy pds');
    expect(result).toEqual({ action: 'CLOSE', symbol: 'MSFT', strategy: 'PDS' });
  });

  test('propagates top-level expiry to legs without expiry', () => {
    const result = parseSignalText('action OPEN, symbol SPY, direction LONG, strategy CALL, expiry LEAP, legs [BUY 0C]');
    expect(result).toMatchObject({
      action: 'OPEN',
      symbol: 'SPY',
      legs: [{ action: 'BUY', strike: 0, optionType: 'CALL', expiry: 'LEAP' }],
    });
  });

  test('creates synthetic leg from top-level expiry when no legs present', () => {
    const result = parseSignalText('action OPEN, symbol SPY, direction LONG, strategy CALL, expiry LEAP');
    expect(result).toMatchObject({
      action: 'OPEN',
      symbol: 'SPY',
      legs: [{ action: 'BUY', strike: 0, optionType: 'CALL', expiry: 'LEAP' }],
    });
  });

  test('injects LEAP expiry from context when model drops it from legs', () => {
    // Model says "action OPEN, symbol SPY, direction LONG, strategy CALL" but text contains "Leap"
    // and no expiry was parsed - should inject LEAP
    const result = parseSignalText('action OPEN, symbol SPY, direction LONG, strategy CALL, Leap calls added');
    expect(result).toMatchObject({
      action: 'OPEN',
      symbol: 'SPY',
      legs: [{ action: 'BUY', strike: 0, optionType: 'CALL', expiry: 'LEAP' }],
    });
  });

  test('LEAP fallback does not override existing leg expiry', () => {
    const result = parseSignalText('action OPEN, symbol SPY, direction LONG, strategy CALL, expiry LEAP, legs [BUY 0C expiry=LEAP]');
    expect(result).toMatchObject({
      legs: [{ expiry: 'LEAP' }],
    });
  });
});

// ── parseLegsText ────────────────────────────────────────────────────

describe('parseLegsText', () => {
  test('parses two spread legs', () => {
    const result = parseLegsText('BUY 507.5P, SELL 500P');
    expect(result).toEqual([
      { action: 'BUY', strike: 507.5, optionType: 'PUT' },
      { action: 'SELL', strike: 500, optionType: 'PUT' },
    ]);
  });

  test('parses call legs', () => {
    const result = parseLegsText('BUY 180C, SELL 185C');
    expect(result).toEqual([
      { action: 'BUY', strike: 180, optionType: 'CALL' },
      { action: 'SELL', strike: 185, optionType: 'CALL' },
    ]);
  });

  test('parses single leg', () => {
    const result = parseLegsText('BUY 100P');
    expect(result).toEqual([{ action: 'BUY', strike: 100, optionType: 'PUT' }]);
  });

  test('parses leg with expiry', () => {
    const result = parseLegsText('BUY 180C expiry=Oct');
    expect(result).toEqual([{ action: 'BUY', strike: 180, optionType: 'CALL', expiry: 'Oct' }]);
  });

  test('returns empty for unparseable text', () => {
    expect(parseLegsText('something else')).toEqual([]);
  });

  test('parses zero-strike LEAP leg', () => {
    const result = parseLegsText('BUY 0C expiry=LEAP');
    expect(result).toEqual([{ action: 'BUY', strike: 0, optionType: 'CALL', expiry: 'LEAP' }]);
  });
});
