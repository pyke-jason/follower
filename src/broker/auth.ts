import { createLogger } from '../lib/logger.js';

const log = createLogger('Auth');
const TOKEN_URL = 'https://signin.tradestation.com/oauth/token';

let accessToken: string | null = null;
let tokenExpiresAt = 0;

export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
    return accessToken;
  }

  const clientId = process.env.TS_CLIENT_ID;
  const clientSecret = process.env.TS_CLIENT_SECRET;
  const refreshToken = process.env.TS_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing TradeStation credentials: TS_CLIENT_ID, TS_CLIENT_SECRET, TS_REFRESH_TOKEN');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
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

  log.debug(`Token refreshed, expires in ${data.expires_in} seconds`);
  return accessToken;
}
