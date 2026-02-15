type Severity = 'critical' | 'warning' | 'info';

type AlertField = { name: string; value: string; inline?: boolean };

type SystemAlertParams = {
  title: string;
  message: string;
  severity: Severity;
  fields?: AlertField[];
};

const COLORS: Record<Severity, number> = {
  critical: 0xff0000, // Red
  warning: 0xffaa00,  // Yellow
  info: 0x0099ff,     // Blue
};

/**
 * Send an emergency push notification via Pushover.
 * Never throws — alerting must not crash callers.
 * Returns silently if PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY are not set.
 */
export async function sendPushover(title: string, message: string): Promise<void> {
  if (process.env.ALERTS_PUSHOVER_ENABLED === '0') return;

  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;

  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        user,
        title,
        message,
        priority: 2,
        retry: 60,
        expire: 600,
        sound: 'siren',
      }),
    });
    if (!res.ok) {
      console.warn(`[Alert] Pushover responded ${res.status}`);
    }
  } catch (err) {
    console.warn('[Alert] Pushover request failed:', err);
  }
}

/**
 * Send a system alert to Discord and console.
 * Never throws — alerting must not crash callers.
 */
export async function sendSystemAlert(params: SystemAlertParams): Promise<void> {
  const { title, message, severity, fields } = params;

  // Always log to console first (survives Discord outages)
  const logFn = severity === 'critical' ? console.error : severity === 'warning' ? console.warn : console.log;
  logFn(`[Alert:${severity.toUpperCase()}] ${title}: ${message}`);

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl || process.env.ALERTS_DISCORD_ENABLED === '0') return;

  try {
    const embed: Record<string, unknown> = {
      title: `[${severity.toUpperCase()}] ${title}`,
      description: message,
      color: COLORS[severity],
      timestamp: new Date().toISOString(),
    };
    if (fields?.length) {
      embed.fields = fields;
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Trade Follower',
        embeds: [embed],
      }),
    });
    if (!res.ok) {
      console.warn(`[Alert] Discord webhook responded ${res.status}`);
    }
  } catch (err) {
    console.warn('[Alert] Discord webhook request failed:', err);
  }

  if (severity === 'critical') {
    await sendPushover(title, message);
  }
}
