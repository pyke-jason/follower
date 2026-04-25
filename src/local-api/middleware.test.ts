import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireLocalhost, requireXRequestedWith, rateLimiter } from './middleware.js';

function makeApp(mw: Parameters<Hono['use']>[1]) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: 'Internal error' }, 500);
  });
  app.use('*', mw);
  app.get('/', (c) => c.json({ ok: true }));
  app.post('/', (c) => c.json({ ok: true }));
  return app;
}

function fakeEnv(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress } } };
}

// ─── requireLocalhost ────────────────────────────────

describe('requireLocalhost', () => {
  test('passes when c.env.incoming is absent (test environment)', async () => {
    const app = makeApp(requireLocalhost());
    const res = await app.request('/');
    expect(res.status).toBe(200);
  });

  test('passes for 127.0.0.1', async () => {
    const app = makeApp(requireLocalhost());
    const res = await app.request('/', {}, fakeEnv('127.0.0.1'));
    expect(res.status).toBe(200);
  });

  test('passes for ::1 (IPv6 loopback)', async () => {
    const app = makeApp(requireLocalhost());
    const res = await app.request('/', {}, fakeEnv('::1'));
    expect(res.status).toBe(200);
  });

  test('passes for ::ffff:127.0.0.1 (IPv4-mapped loopback)', async () => {
    const app = makeApp(requireLocalhost());
    const res = await app.request('/', {}, fakeEnv('::ffff:127.0.0.1'));
    expect(res.status).toBe(200);
  });

  test('rejects when remote address is a LAN IP', async () => {
    const app = makeApp(requireLocalhost());
    const res = await app.request('/', {}, fakeEnv('192.168.1.42'));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toMatch(/localhost only/i);
  });

  test('rejects for a public IP', async () => {
    const app = makeApp(requireLocalhost());
    const res = await app.request('/', {}, fakeEnv('203.0.113.1'));
    expect(res.status).toBe(403);
  });
});

// ─── requireXRequestedWith ───────────────────────────

describe('requireXRequestedWith', () => {
  const app = makeApp(requireXRequestedWith());

  test('passes when header is present (GET)', async () => {
    const res = await app.request('/', { headers: { 'x-requested-with': 'fetch' } });
    expect(res.status).toBe(200);
  });

  test('rejects GET without header', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toMatch(/X-Requested-With/i);
  });

  test('passes POST with header', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects POST without header', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
  });
});

// ─── rateLimiter ─────────────────────────────────────

describe('rateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test('allows requests up to the limit', async () => {
    const app = makeApp(rateLimiter(3));
    for (let i = 0; i < 3; i++) {
      expect((await app.request('/')).status).toBe(200);
    }
  });

  test('rejects the request that exceeds the limit', async () => {
    const app = makeApp(rateLimiter(2));
    await app.request('/');
    await app.request('/');
    const res = await app.request('/');
    expect(res.status).toBe(429);
    expect((await res.json() as { error: string }).error).toMatch(/rate limit/i);
  });

  test('resets after the window expires', async () => {
    const app = makeApp(rateLimiter(1));
    await app.request('/');
    expect((await app.request('/')).status).toBe(429);

    vi.advanceTimersByTime(61_000);
    expect((await app.request('/')).status).toBe(200);
  });

  test('tracks different paths independently', async () => {
    const multiApp = new Hono();
    multiApp.use('*', rateLimiter(1));
    multiApp.get('/a', (c) => c.json({ ok: true }));
    multiApp.get('/b', (c) => c.json({ ok: true }));

    await multiApp.request('/a');
    expect((await multiApp.request('/a')).status).toBe(429);
    expect((await multiApp.request('/b')).status).toBe(200);
  });
});
