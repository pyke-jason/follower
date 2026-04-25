import { describe, expect, test } from 'vitest';
import { isSignalRSubscriptionReady, type SignalRInjectionStatus } from './signalr.js';

function status(overrides: Partial<SignalRInjectionStatus>): SignalRInjectionStatus {
  return {
    signalRAvailable: true,
    addMessageConnected: true,
    reactionProxyAttached: true,
    transportName: 'webSockets',
    connectionState: 1,
    existingConnectionState: 1,
    details: 'ok',
    ...overrides,
  };
}

describe('isSignalRSubscriptionReady', () => {
  test('requires SignalR, addMessage, and the page chat-room proxy', () => {
    expect(isSignalRSubscriptionReady(status({}))).toBe(true);
    expect(isSignalRSubscriptionReady(status({ signalRAvailable: false }))).toBe(false);
    expect(isSignalRSubscriptionReady(status({ addMessageConnected: false }))).toBe(false);
    expect(isSignalRSubscriptionReady(status({ reactionProxyAttached: false }))).toBe(false);
  });
});
