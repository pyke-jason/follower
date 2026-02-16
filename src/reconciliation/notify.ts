import type { ReconciliationAlertInput } from './reconciler.js';
import { sendPushover } from '../lib/alert.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Discord');

const COLORS: Record<string, number> = {
  DB_ONLY: 0xff0000,           // Red — dangerous
  BROKER_ONLY: 0xffaa00,       // Yellow — warning
  QUANTITY_MISMATCH: 0xffaa00, // Yellow — warning
};

/**
 * Send reconciliation alerts to a Discord webhook.
 * Fails silently if DISCORD_WEBHOOK_URL is not set or request fails.
 */
export async function sendDiscordAlert(alerts: ReconciliationAlertInput[]): Promise<void> {
  if (process.env.ALERTS_DISCORD_ENABLED === '0') return;

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    log.debug('DISCORD_WEBHOOK_URL not set, skipping alert notification');
    return;
  }

  const embeds = alerts.map((alert) => ({
    title: `Reconciliation: ${alert.type}`,
    color: COLORS[alert.type] ?? 0x808080,
    fields: [
      { name: 'Symbol', value: alert.symbol, inline: true },
      { name: 'Type', value: alert.type, inline: true },
      ...(alert.tradeId ? [{ name: 'Trade ID', value: alert.tradeId, inline: true }] : []),
      { name: 'Expected', value: `\`\`\`json\n${JSON.stringify(alert.expected, null, 2)}\n\`\`\``, inline: false },
      { name: 'Actual', value: `\`\`\`json\n${JSON.stringify(alert.actual, null, 2)}\n\`\`\``, inline: false },
    ],
    timestamp: new Date().toISOString(),
  }));

  // Discord limits to 10 embeds per message
  const batches = [];
  for (let i = 0; i < embeds.length; i += 10) {
    batches.push(embeds.slice(i, i + 10));
  }

  for (const batch of batches) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Trade Follower',
          embeds: batch,
        }),
      });
      if (!res.ok) {
        log.warn(`Discord webhook responded ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      log.warn('Discord webhook request failed:', err);
    }
  }

  const dbOnly = alerts.filter((a) => a.type === 'DB_ONLY');
  if (dbOnly.length > 0) {
    const symbols = Array.from(new Set(dbOnly.map((a) => a.symbol))).join(', ');
    await sendPushover(
      'Reconciliation: DB_ONLY',
      `${dbOnly.length} position(s) in DB but not at broker: ${symbols}`,
    );
  }
}
