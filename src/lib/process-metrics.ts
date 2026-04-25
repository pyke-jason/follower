import { readdir } from 'node:fs/promises';
import { sendSystemAlert } from './alert.js';

const INTERVAL_MS = 5 * 60_000; // 5 minutes
const DRIFT_WINDOW = 12; // samples — 1 hour at 5-min intervals
const DRIFT_THRESHOLD_MB_PER_HOUR = 50;

let metricsTimer: ReturnType<typeof setInterval> | null = null;
let heapSamples: number[] = [];

async function getFdCount(): Promise<number | null> {
  try {
    const entries = await readdir('/proc/self/fd');
    return entries.length;
  } catch {
    return null; // not Linux
  }
}

async function logMetrics(): Promise<void> {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const fdCount = await getFdCount();

  const fdStr = fdCount != null ? ` fds=${fdCount}` : '';
  console.log(`[Metrics] heap=${heapMB}MB rss=${rssMB}MB${fdStr}`);

  heapSamples.push(heapMB);
  if (heapSamples.length > DRIFT_WINDOW) heapSamples.shift();

  if (heapSamples.length === DRIFT_WINDOW) {
    const oldest = heapSamples[0];
    const growthMB = heapMB - oldest;
    const elapsedHours = (DRIFT_WINDOW - 1) * INTERVAL_MS / 3_600_000;
    const growthPerHour = growthMB / elapsedHours;

    if (growthPerHour > DRIFT_THRESHOLD_MB_PER_HOUR) {
      const message = `Heap grew +${Math.round(growthPerHour)}MB/hr over the last hour (${oldest}→${heapMB}MB) — possible memory leak`;
      console.warn(`[Metrics] ${message}`);
      void sendSystemAlert({ title: 'Process: heap drift detected', message, severity: 'warning' });
      heapSamples = []; // reset window to avoid repeated alerts until next full hour
    }
  }
}

export function startMetrics(): void {
  heapSamples = [];
  logMetrics().catch(() => {});
  metricsTimer = setInterval(() => { logMetrics().catch(() => {}); }, INTERVAL_MS);
}

export function stopMetrics(): void {
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
  heapSamples = [];
}
