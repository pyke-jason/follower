import { describe, expect, test } from 'vitest';
import { shouldSendRecoveryAlert, staleRecoveredMessages } from './recovery.js';

describe('staleRecoveredMessages', () => {
  test('keeps only recovered messages older than the grace window', () => {
    const now = new Date('2026-04-25T14:31:00.000Z');
    const messages = [
      { id: 'fresh', timestamp: '2026-04-25T14:30:45.000Z' },
      { id: 'stale', timestamp: '2026-04-25T14:29:50.000Z' },
    ];

    expect(staleRecoveredMessages(messages, now, 45_000).map((m) => m.id)).toEqual(['stale']);
  });

  test('treats malformed timestamps as stale', () => {
    const messages = [{ id: 'bad', timestamp: 'not-a-date' }];
    expect(staleRecoveredMessages(messages, new Date('2026-04-25T14:31:00.000Z'), 45_000)).toEqual(messages);
  });
});

describe('shouldSendRecoveryAlert', () => {
  test('allows first alert and throttles repeated alerts', () => {
    const now = new Date('2026-04-25T14:31:00.000Z');
    expect(shouldSendRecoveryAlert(null, now, 300_000)).toBe(true);
    expect(shouldSendRecoveryAlert(new Date('2026-04-25T14:29:00.000Z'), now, 300_000)).toBe(false);
    expect(shouldSendRecoveryAlert(new Date('2026-04-25T14:20:00.000Z'), now, 300_000)).toBe(true);
  });
});
