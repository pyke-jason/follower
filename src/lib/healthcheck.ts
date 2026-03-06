let timer: ReturnType<typeof setInterval> | null = null;

const INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_SIDECAR_URL = 'http://localhost:8090/api';

/**
 * Check whether the IBKR sidecar is reachable and connected to IB Gateway.
 * Returns true if healthy, false if degraded/unreachable.
 * Non-IBKR brokers always return true (no sidecar to check).
 */
async function isSidecarHealthy(): Promise<boolean> {
  const { getRuntimeChannelDefinitions } = await import('./runtime-channels.js');
  const defs = getRuntimeChannelDefinitions().filter((d) => d.brokerName === 'ibkr');
  if (defs.length === 0) return true;

  const sidecarUrls = [...new Set(defs.map((d) => d.sidecarUrl ?? DEFAULT_SIDECAR_URL))];
  for (const base of sidecarUrls) {
    try {
      const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return false;
      const body = await res.json() as { connected?: boolean };
      if (body.connected !== true) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Start pinging healthchecks.io every 60 seconds.
 * For IBKR broker, checks sidecar status first — pings /fail if degraded.
 * Never throws — monitoring must not crash callers.
 * Returns silently if HEALTHCHECK_PING_URL is not set.
 */
export function startHealthcheck(): void {
  if (process.env.HEALTHCHECK_ENABLED === '0') return;
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
