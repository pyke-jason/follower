# Local API Security Hardening (Pre-live)

## Problem

The local-api server had five security issues discovered in a pre-launch audit:

1. **Bound to 0.0.0.0** — `serve()` had no `hostname`, defaulting to all interfaces. Anyone on the LAN could reach trading endpoints.
2. **No CSRF protection** — All mutating endpoints (place order, force exit, write secrets) were reachable from any browser page that could reach localhost, including cross-origin requests via HTML form.
3. **CORS over-permissive** — `app.oneoption.com` was included in the global CORS config, meaning code on that domain could call *any* route including order placement.
4. **No rate limiting** — Rapid-fire `POST /web/orders` or force-exit calls could place runaway broker orders.
5. **Unconstrained secret key format** — `POST /settings/secrets` accepted arbitrary strings as keys, allowing writes of malformed entries to the macOS Keychain.

## Decision

- Bind to `127.0.0.1` explicitly in `serve()`.
- New `middleware.ts` with `requireLocalhost` (TCP address check, defense-in-depth), `requireXRequestedWith` (CSRF guard), and `rateLimiter` (token bucket per path).
- Apply `requireXRequestedWith` to all `POST/PUT/DELETE/PATCH` under `/web/*`. The frontend's `api()` client sends the header; internal server-to-server calls go to `/backtests/*` or `/trades/*` (not `/web/*`) and are unaffected.
- Narrow `app.oneoption.com` CORS to only the `/ingest-backfill` route.
- Rate-limit `/web/orders` (10/min) and `/web/trades/*` (5/min).
- Add `^[A-Z][A-Z0-9_]*$` regex to `SettingsSecretBodySchema.key` and the `DELETE /settings/secrets/:key` param.

## Key Files

- `src/local-api/middleware.ts` — new security middleware
- `src/local-api/middleware.test.ts` — 14 unit tests
- `src/local-api/server.ts` — bind address, CORS split, middleware wiring
- `web/src/lib/api.ts` — `X-Requested-With: fetch` on all API calls
- `src/local-api/http-schemas.ts` — key format validation
- `src/local-api/routes/web-mutations.ts` — key format validation on DELETE param

## Watch Out

- `/trades/force-exit` and `/backtests/spawn` are internal routes called by the server itself via `fetch(LOCAL_API_URL/...)`. They do NOT have `requireXRequestedWith` applied — only the browser-facing `/web/*` routes do. Do not add the middleware to those internal paths.
- If you add a new cross-origin caller (e.g. a browser extension on a different domain), add a targeted `app.use('/specific-route', cors({ origin: 'https://...' }))` rather than broadening the global CORS config.
- The rate limiter is in-memory. It resets on server restart. It is not a substitute for broker-side order throttling.
