type RecoveryCandidate = {
  timestamp: string;
};

export function staleRecoveredMessages<T extends RecoveryCandidate>(
  messages: T[],
  now: Date,
  graceMs: number,
): T[] {
  const nowMs = now.getTime();
  return messages.filter((message) => {
    const timestampMs = new Date(message.timestamp).getTime();
    if (!Number.isFinite(timestampMs)) return true;
    return nowMs - timestampMs >= graceMs;
  });
}

export function shouldSendRecoveryAlert(
  lastAlertAt: Date | null,
  now: Date,
  cooldownMs: number,
): boolean {
  return !lastAlertAt || now.getTime() - lastAlertAt.getTime() >= cooldownMs;
}
