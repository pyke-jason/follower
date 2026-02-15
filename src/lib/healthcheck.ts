let timer: ReturnType<typeof setInterval> | null = null;

const INTERVAL_MS = 60_000; // 1 minute

/**
 * Start pinging healthchecks.io every 60 seconds.
 * Never throws — monitoring must not crash callers.
 * Returns silently if HEALTHCHECK_PING_URL is not set.
 */
export function startHealthcheck(): void {
  const url = process.env.HEALTHCHECK_PING_URL;
  if (!url) return;

  const ping = async () => {
    try {
      const res = await fetch(url);
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
