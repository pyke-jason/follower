import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Checks that the TCP connection came from the loopback interface.
// When c.env.incoming is absent (e.g. direct app.request() in tests) the
// check is skipped — the bind-address fix in server.ts is the primary guard.
export function requireLocalhost(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    if (incoming) {
      const addr = incoming.socket?.remoteAddress ?? '';
      const ok = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
      if (!ok) {
        throw new HTTPException(403, { message: 'Forbidden: localhost only' });
      }
    }
    return next();
  };
}

// Requires the X-Requested-With header on all requests that hit it.
// HTML forms cannot set arbitrary headers, so this defeats simple
// cross-site form-submission CSRF against the browser-facing /web/* routes.
export function requireXRequestedWith(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.req.header('x-requested-with')) {
      throw new HTTPException(403, { message: 'Missing X-Requested-With header' });
    }
    return next();
  };
}

// Per-path token-bucket rate limiter. Prevents rapid-fire order placement
// from runaway scripts or stuck UIs. maxPerMinute is per distinct URL path.
export function rateLimiter(maxPerMinute: number): MiddlewareHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return async (c, next) => {
    const key = c.req.path;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return next();
    }

    if (bucket.count >= maxPerMinute) {
      return c.json({ error: 'Rate limit exceeded — slow down' }, 429);
    }

    bucket.count++;
    return next();
  };
}
