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
  test('requires SignalR and addMessage; reaction proxy is optional', () => {
    expect(isSignalRSubscriptionReady(status({}))).toBe(true);
    expect(isSignalRSubscriptionReady(status({ signalRAvailable: false }))).toBe(false);
    expect(isSignalRSubscriptionReady(status({ addMessageConnected: false }))).toBe(false);
    // reactionProxyAttached=false no longer downgrades readiness — addMessage
    // carries every new message; the reaction proxy is only used for emoji
    // updates the trade pipeline never consumes.
    expect(isSignalRSubscriptionReady(status({ reactionProxyAttached: false }))).toBe(true);
  });
});
