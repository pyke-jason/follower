'use server';

import { revalidatePath } from 'next/cache';
import { getProvider, SECRET_KEYS } from '@src/lib/secrets';

type Result = { ok: boolean; error?: string };

export type SecretEntry = { key: string; isSet: boolean };

export async function listSecrets(): Promise<SecretEntry[]> {
  const provider = getProvider();
  const setKeys = await provider.list();
  const setKeySet = new Set(setKeys);
  return SECRET_KEYS
    .filter((key) => !(key in TOGGLE_KEYS))
    .map((key) => ({ key, isSet: setKeySet.has(key) }));
}

/** Maps UI toggle names to their secret key. */
const TOGGLE_KEYS: Record<string, string> = {
  ALERTS_DISCORD_ENABLED: 'ALERTS_DISCORD_ENABLED',
  ALERTS_PUSHOVER_ENABLED: 'ALERTS_PUSHOVER_ENABLED',
  LIVE_INGESTION_ENABLED: 'LIVE_INGESTION_ENABLED',
};

export type ToggleId = 'discord' | 'pushover' | 'ingestion';

const TOGGLE_ENV: Record<ToggleId, string> = {
  discord: 'ALERTS_DISCORD_ENABLED',
  pushover: 'ALERTS_PUSHOVER_ENABLED',
  ingestion: 'LIVE_INGESTION_ENABLED',
};

export async function getToggleStates(): Promise<Record<ToggleId, boolean>> {
  const provider = getProvider();
  const secrets = await provider.load();
  return {
    discord: secrets.ALERTS_DISCORD_ENABLED !== '0',
    pushover: secrets.ALERTS_PUSHOVER_ENABLED !== '0',
    ingestion: secrets.LIVE_INGESTION_ENABLED !== '0',
  };
}

export async function toggleSetting(id: ToggleId, enabled: boolean): Promise<Result> {
  const key = TOGGLE_ENV[id];
  try {
    const provider = getProvider();
    await provider.set(key, enabled ? '1' : '0');
    revalidatePath('/settings');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setSecret(_prev: Result | null, formData: FormData): Promise<Result> {
  const key = formData.get('key') as string;
  const value = formData.get('value') as string;
  if (!key || !value) return { ok: false, error: 'Key and value are required' };

  try {
    const provider = getProvider();
    await provider.set(key, value);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteSecret(_prev: Result | null, formData: FormData): Promise<Result> {
  const key = formData.get('key') as string;
  if (!key) return { ok: false, error: 'Key is required' };

  try {
    const provider = getProvider();
    await provider.delete(key);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function testDiscord(): Promise<Result> {
  const provider = getProvider();
  const secrets = await provider.load();
  const webhookUrl = secrets.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return { ok: false, error: 'DISCORD_WEBHOOK_URL is not set' };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Trade Follower',
        embeds: [
          {
            title: '[INFO] Test',
            description: 'Test alert from Trade Follower web UI',
            color: 0x0099ff,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Discord responded ${res.status}: ${body}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function testPushover(): Promise<Result> {
  const provider = getProvider();
  const secrets = await provider.load();
  const token = secrets.PUSHOVER_APP_TOKEN;
  const user = secrets.PUSHOVER_USER_KEY;
  if (!token || !user) return { ok: false, error: 'PUSHOVER_APP_TOKEN or PUSHOVER_USER_KEY is not set' };

  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        user,
        title: 'Test',
        message: 'Test alert from Trade Follower web UI',
        priority: 2,
        retry: 60,
        expire: 600,
        sound: 'siren',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Pushover responded ${res.status}: ${body}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
