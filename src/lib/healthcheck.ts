let timer: ReturnType<typeof setInterval> | null = null;

const INTERVAL_MS = 60_000; // 1 minute

/**
 * Check whether the IBKR sidecar is reachable and connected to IB Gateway.
 * Returns true if healthy, false if degraded/unreachable.
 * Non-IBKR brokers always return true (no sidecar to check).
 */
async function isSidecarHealthy(): Promise<boolean> {
  if (process.env.BROKER !== 'ibkr') return true;

  const base = process.env.IBKR_SIDECAR_URL ?? 'http://localhost:8090/api';
  try {
    const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    const body = await res.json() as { connected?: boolean };
    return body.connected === true;
  } catch {
    return false;
  }
}

/**
 * Start pinging healthchecks.io every 60 seconds.
 * For IBKR broker, checks sidecar status first — pings /fail if degraded.
 * Never throws — monitoring must not crash callers.
 * Returns silently if HEALTHCHECK_PING_URL is not set.
 */
export function startHealthcheck(): void {
  if (process.env.HEALTHCHECK_ENABLED === '0') return;
  if (process.env.IBKR_GATEWAY_PORT === '4002') return; // paper trading
  const url = process.env.HEALTHCHECK_PING_URL;
  if (!url) return;

  const ping = async () => {
    try {
      const healthy = await isSidecarHealthy();
      const pingUrl = healthy ? url : `${url}/fail`;
      const res = await fetch(pingUrl);
      if (!res.ok) {
        console.warn(`[Healthcheck] Ping responded ${res.status}`);
      }
    } catch (err) {
      console.warn('[Healthcheck] Ping failed:', err);
    }
  };

  // Ping immediately on start, then every interval
  ping();
  timer = setInterval(ping, INTERVAL_MS);
}

export function stopHealthcheck(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
