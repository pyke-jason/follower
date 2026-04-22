import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendSystemAlert } from './alert.js';

const execFileP = promisify(execFile);

const INTERVAL_MS = 60_000;
const WARNING_PERCENT = 25;
const CRITICAL_PERCENT = 10;
const CRITICAL_MINUTES_LEFT = 15;

type BatteryStatus = {
  onBattery: boolean;
  charging: boolean;
  percent: number;
  minutesRemaining: number | null;
};

let timer: ReturnType<typeof setInterval> | null = null;
let firedWarning = false;
let firedCritical = false;
let firedTimeLeft = false;

export function parseBattery(stdout: string): BatteryStatus | null {
  const source = stdout.match(/drawing from '([^']+)'/i);
  if (!source) return null;
  const onBattery = /battery/i.test(source[1]);

  const line = stdout.split('\n').find((l) => /InternalBattery/i.test(l));
  if (!line) return null;

  const pct = line.match(/(\d+)%/);
  if (!pct) return null;
  const percent = parseInt(pct[1], 10);

  const charging = /\b(charging|charged|finishing charge)\b/i.test(line) && !/discharging/i.test(line);

  let minutesRemaining: number | null = null;
  const time = line.match(/(\d+):(\d{2})\s+remaining/i);
  if (time) minutesRemaining = parseInt(time[1], 10) * 60 + parseInt(time[2], 10);

  return { onBattery, charging, percent, minutesRemaining };
}

async function readBattery(): Promise<BatteryStatus | null> {
  try {
    const { stdout } = await execFileP('/usr/bin/pmset', ['-g', 'batt']);
    return parseBattery(stdout);
  } catch (err) {
    console.warn('[BatteryMonitor] pmset failed:', err);
    return null;
  }
}

async function tick(): Promise<void> {
  const s = await readBattery();
  if (!s) return;

  if (!s.onBattery || s.charging) {
    firedWarning = false;
    firedCritical = false;
    firedTimeLeft = false;
    return;
  }

  const timeLeftStr = s.minutesRemaining != null ? `${s.minutesRemaining} min` : 'unknown';
  const baseFields = [
    { name: 'Battery', value: `${s.percent}%`, inline: true },
    { name: 'Time left', value: timeLeftStr, inline: true },
  ];

  if (s.percent <= CRITICAL_PERCENT && !firedCritical) {
    firedCritical = true;
    await sendSystemAlert({
      title: 'Mac battery critical',
      message: `Battery at ${s.percent}% on battery power. Connect power now — trade-follower will die on shutdown.`,
      severity: 'critical',
      fields: baseFields,
    });
  } else if (s.percent <= WARNING_PERCENT && !firedWarning) {
    firedWarning = true;
    await sendSystemAlert({
      title: 'Mac battery low',
      message: `Battery at ${s.percent}% on battery power.`,
      severity: 'warning',
      fields: baseFields,
    });
  }

  if (
    s.minutesRemaining != null &&
    s.minutesRemaining <= CRITICAL_MINUTES_LEFT &&
    !firedTimeLeft
  ) {
    firedTimeLeft = true;
    await sendSystemAlert({
      title: 'Mac about to die',
      message: `${s.minutesRemaining} minutes of battery left at ${s.percent}%. Connect power now.`,
      severity: 'critical',
      fields: baseFields,
    });
  }
}

export function startBatteryMonitor(): void {
  if (process.env.BATTERY_MONITOR_ENABLED === '0') return;
  if (process.platform !== 'darwin') return;
  if (timer) return;
  tick().catch(() => {});
  timer = setInterval(() => {
    tick().catch(() => {});
  }, INTERVAL_MS);
}

