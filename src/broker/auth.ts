import { z } from 'zod';

const TOKEN_URL = 'https://signin.tradestation.com/oauth/token';

const AuthEnvSchema = z.object({
  TS_CLIENT_ID: z.string().min(1, 'Missing TS_CLIENT_ID'),
  TS_CLIENT_SECRET: z.string().min(1, 'Missing TS_CLIENT_SECRET'),
  TS_REFRESH_TOKEN: z.string().min(1, 'Missing TS_REFRESH_TOKEN'),
});

const authEnv = AuthEnvSchema.parse({
  TS_CLIENT_ID: process.env.TS_CLIENT_ID,
  TS_CLIENT_SECRET: process.env.TS_CLIENT_SECRET,
  TS_REFRESH_TOKEN: process.env.TS_REFRESH_TOKEN,
});

let accessToken: string | null = null;
let tokenExpiresAt = 0;

export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
    return accessToken;
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: authEnv.TS_CLIENT_ID,
    client_secret: authEnv.TS_CLIENT_SECRET,
    refresh_token: authEnv.TS_REFRESH_TOKEN,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log('[Auth] Token refreshed, expires in', data.expires_in, 'seconds');
  return accessToken;
}
