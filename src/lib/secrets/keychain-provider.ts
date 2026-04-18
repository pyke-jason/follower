import { execFile } from 'node:child_process';
import type { SecretProvider } from './types';

const SERVICE = 'trade-follower';
const TIMEOUT_MS = 5_000;

/** All keys we expect to find in the keychain. */
export const SECRET_KEYS = [
  'ENABLED_CHANNEL_IDS',
  'IBKR_LIVE_ACCOUNT_ID',
  'IBKR_PAPER_ACCOUNT_ID',
  'IBKR_LIVE_SIDECAR_URL',
  'IBKR_PAPER_SIDECAR_URL',
  'IBKR_LIVE_SIDECAR_WS',
  'IBKR_PAPER_SIDECAR_WS',
  'ANTHROPIC_API_KEY',
  'DATABENTO_API_KEY',
  'ONE_OP_EMAIL',
  'ONE_OP_PASS',
  'DATABASE_URL',
  'DISCORD_WEBHOOK_URL',
  'PUSHOVER_APP_TOKEN',
  'PUSHOVER_USER_KEY',
  'HEALTHCHECK_PING_URL',
  'HISTORICAL_DB_URL',
  'ALERTS_DISCORD_ENABLED',
  'ALERTS_PUSHOVER_ENABLED',
  'LIVE_INGESTION_ENABLED',
  'XAI_API_KEY',
  'TRADE_MODEL_PROVIDER',
  'TRADE_MODEL',
  'GMAIL_EMAIL',
  'GMAIL_PASSWORD',
  'ICLOUD_EMAIL',
  'ICLOUD_APP_PASSWORD',
];

function run(args: string[], timeout = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/security',
      args,
      { timeout },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trimEnd());
      },
    );
    child.on('error', reject);
  });
}

function readKeychain(key: string): Promise<string | null> {
  return run(['find-generic-password', '-s', SERVICE, '-a', key, '-w']).catch(() => null);
}

export class KeychainProvider implements SecretProvider {
  readonly name = 'keychain';

  async load(): Promise<Record<string, string>> {
    const results = await Promise.all(
      SECRET_KEYS.map(async (key) => {
        const value = await readKeychain(key);
        return [key, value] as const;
      }),
    );

    const secrets: Record<string, string> = {};
    let skipped = 0;

    for (const [key, value] of results) {
      if (value !== null) {
        secrets[key] = value;
      } else {
        skipped++;
      }
    }

    if (skipped > 0) {
      console.warn(`[secrets] keychain: ${skipped} key(s) not found or timed out — will fall back to .env`);
    }

    return secrets;
  }

  async list(): Promise<string[]> {
    const results = await Promise.all(
      SECRET_KEYS.map(async (key) => {
        const value = await readKeychain(key);
        return value !== null ? key : null;
      }),
    );
    return results.filter((k): k is string => k !== null);
  }

  async set(key: string, value: string): Promise<void> {
    // Delete first — keychain rejects duplicates
    try {
      await run(['delete-generic-password', '-s', SERVICE, '-a', key]);
    } catch {
      // OK if it didn't exist
    }

    await run([
      'add-generic-password',
      '-s', SERVICE,
      '-a', key,
      '-w', value,
      '-T', '/usr/bin/security',
    ]);

    // Also update process.env so the running process sees the change
    process.env[key] = value;
  }

  async delete(key: string): Promise<void> {
    await run(['delete-generic-password', '-s', SERVICE, '-a', key]);
    delete process.env[key];
  }
}
