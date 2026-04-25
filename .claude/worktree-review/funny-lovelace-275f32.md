# Worktree audit: funny-lovelace-275f32 — local-api security hardening

## Goal

Pre-live hardening of the Hono local API (`:3791`). Author identified five issues: bind to all interfaces, no CSRF guard on mutations, over-permissive CORS allowing `app.oneoption.com` to reach trading endpoints, no rate limiting on order placement, and unconstrained secret-key strings reaching the macOS Keychain.

## Changes

- `src/local-api/server.ts` — bind to `127.0.0.1` explicitly in `serve({ hostname })`. Split CORS: localhost-only globally, `app.oneoption.com` scoped to `/ingest-backfill`. Wire three new middlewares: `requireLocalhost` globally, `requireXRequestedWith` for mutating verbs under `/web/*`, `rateLimiter(10)` on `/web/orders` and `rateLimiter(5)` on `/web/trades/*`.
- `src/local-api/middleware.ts` (new, 55 lines) — three middlewares above. Token-bucket per URL path, 1-minute window.
- `src/local-api/middleware.test.ts` (new, 14 tests) — covers all three with fake `incoming.socket.remoteAddress` env.
- `src/local-api/http-schemas.ts` — `SettingsSecretBodySchema.key` regex `^[A-Z][A-Z0-9_]*$`.
- `src/local-api/routes/web-mutations.ts` — same regex on `DELETE /settings/secrets/:key`.
- `web/src/lib/api.ts` — sends `X-Requested-With: fetch` on every API call.
- `docs/lessons/2026-04-24-local-api-security-hardening.md` — author rationale.

Type check passes; `npx vitest run src/local-api/middleware.test.ts` — 14/14 pass.

## Justification per change

**1. `127.0.0.1` bind.** Necessary. Pre-fix `serve({ fetch, port })` defaults to `0.0.0.0` (all interfaces). Anyone on the LAN (coffee shop, conference Wi-Fi, home guest network) could reach the order placement endpoint. This is a real, single-user-relevant fix and the most important change in the PR. Justified.

**2. Narrowed CORS.** Necessary. Pre-fix the global allowlist included `https://app.oneoption.com`, meaning code running on that domain (or anyone able to inject a script there — chat-room context, browser extension on that page) could call `POST /web/orders`. Splitting CORS so oneoption.com only reaches `/ingest-backfill` (the route designed to receive its chat-widget payload) is correct scoping. Justified.

**3. `requireXRequestedWith` on `/web/*` mutations.** Justified for a single-user dashboard, despite my initial skepticism. The threat is a malicious site the user visits in another tab issuing a cross-origin form POST to `http://localhost:3791/web/orders`. CORS does not block this — a simple POST request reaches the server even if the response is unreadable. `X-Requested-With` cannot be set by an HTML form, only by `fetch`/`XHR` (which trigger preflight, which CORS will block). The pattern is the standard CSRF defense for localhost APIs and is much simpler than tokens. The author correctly limits it to `/web/*` and the four mutating verbs, leaving server-internal `/backtests/*`, `/classify/*`, `/logs/*`, `/trades/*` (called by other server processes via `LOCAL_API_URL`) untouched — verified all internal `fetch(${LOCAL_API_URL}/...)` callers in `src/local-api/routes/*.ts` use those non-`/web` paths. Justified.

**4. `requireLocalhost` middleware (defense-in-depth on bind).** Borderline theatre. The 127.0.0.1 bind is sufficient. The middleware adds a TCP-address check, but if the bind is wrong, the middleware is the only guard, and if the bind is right, the middleware never rejects. Trivial cost (18 lines, well-tested), so I let it pass — but it is the weakest justification in the PR.

**5. Rate limiting `/web/orders` (10/min) and `/web/trades/*` (5/min).** Justified as a correctness backstop, not a security control. Protects against UI bugs (an effect dependency loop firing `mutate()` repeatedly) and human script accidents from translating into broker-side runaway orders. The author correctly flags it as not a substitute for broker throttling. Justified, but see Concerns for the path scoping bug.

**6. Secret key regex.** Justified, minor. Prevents writing arbitrary strings to the Keychain (which becomes a janitorial problem to clean up). Mirrors what real env-var keys look like (`UPPER_SNAKE_CASE`).

**7. `X-Requested-With: fetch` header in `web/src/lib/api.ts`.** Necessary plumbing for #3. Single line. Justified.

## Concerns

1. **`/web/orders/:id` is NOT rate-limited.** `app.use('/web/orders', rateLimiter(10))` matches only the exact path in Hono — it does not cascade to `/web/orders/:id`. PUT (update) and DELETE (cancel) on `/web/orders/:id` both fan out to broker calls and bypass the limiter. Should be `app.use('/web/orders/*', rateLimiter(10))` plus the existing exact match, or fold both into a single starred pattern. Minor but the limiter exists to backstop runaway broker calls — half the broker-touching endpoints are uncovered.

2. **CORS layering is fragile.** Two `app.use('*'/'/ingest-backfill', cors(...))` middlewares both run for `/ingest-backfill`. Hono runs them in order; the second overrides the headers from the first. Currently works (the global cors leaves no `Access-Control-Allow-Origin` for non-allowlisted origins, then the scoped cors sets the right one), but a future reader who adds a third cors will likely break it. Comment in the file is good but the pattern is delicate.

3. **`requireLocalhost` is defense-in-depth.** Already noted above. I would accept the bind change without the middleware, but the middleware is cheap and tested.

4. **Rate limiter is unbounded `Map` growth.** The bucket map keys on `c.req.path`. If a route has dynamic segments and a stray client fires unique paths, the map grows. None of the wired paths (`/web/orders`, `/web/trades/*`) have user-controlled dynamic segments worth abusing on a single-user system, but worth knowing.

5. **No test runs the integration end-to-end (server + middleware wired).** The middleware-level tests are good. There is no test that boots the actual server with a non-loopback `incoming.socket` and gets rejected. Manageable for a 55-line middleware.

## Verdict

**MERGE** (after fixing the path-scoping bug). This is real productionization, not theatre. The `0.0.0.0` bind is a genuine pre-live blocker — the user explicitly stated "wants to go live," and going live with the order-placement endpoint reachable from any LAN device is a foot-cannon. The CORS narrowing closes a real attack surface: `app.oneoption.com` (where the chat widget runs) had no business being able to call `/web/orders`. CSRF on `/web/*` mutations addresses a real cross-origin threat that browsers do not block themselves. Rate limits are a correctness backstop on the runaway-order failure mode that traders care about. The secret-key regex is minor but free. The author's lesson file shows they understood the threat model — they explicitly noted that internal server-to-server callers use `/backtests/*`/`/classify/*`/`/trades/*` (not `/web/*`) and would not be affected, which I confirmed. The work is upstream-enough (one new middleware module, no per-route boilerplate), single-user appropriate (no per-user rate limit, no audit logs, no RBAC), and stays in `src/local-api/` without leaking into pipeline/orders code. The principal complaint is that `/web/orders/:id` falls outside the rate limit; that is a one-line fix.

## Required fixes

1. Change `app.use('/web/orders', rateLimiter(10))` to also cover `/web/orders/*` so PUT/DELETE on `/web/orders/:id` are limited too. Either widen to `/web/orders/*` and accept that the bare path is no longer matched by Hono's prefix rules (verify), or add a second `app.use('/web/orders/*', rateLimiter(10))` line.

## Notes for caller

- Quality gates run in the worktree: `npx tsc --noEmit` (clean) and `npx vitest run src/local-api/middleware.test.ts` (14/14 pass). Did not run full `npm test` / `npm --prefix web run check` / `knip` — main repo has many unrelated `M` files; the author's own diff is clean and focused.
- Key file paths:
  - `/Users/jason/Workspace/trade-follower-3/.claude/worktrees/funny-lovelace-275f32/src/local-api/middleware.ts`
  - `/Users/jason/Workspace/trade-follower-3/.claude/worktrees/funny-lovelace-275f32/src/local-api/middleware.test.ts`
  - `/Users/jason/Workspace/trade-follower-3/.claude/worktrees/funny-lovelace-275f32/src/local-api/server.ts`
  - `/Users/jason/Workspace/trade-follower-3/.claude/worktrees/funny-lovelace-275f32/src/local-api/http-schemas.ts`
  - `/Users/jason/Workspace/trade-follower-3/.claude/worktrees/funny-lovelace-275f32/src/local-api/routes/web-mutations.ts`
  - `/Users/jason/Workspace/trade-follower-3/.claude/worktrees/funny-lovelace-275f32/web/src/lib/api.ts`
  - `/Users/jason/Workspace/trade-follower-3/.claude/worktrees/funny-lovelace-275f32/docs/lessons/2026-04-24-local-api-security-hardening.md`

## Reviewer verdict

**AGREE with thesis, MERGE after the one-line rate-limit fix.** I tried to falsify the "this is productionization, not theatre" framing and could not. The threat model is real for a single-user localhost API because the broker is at the end of the pipe — a stray request that reaches `/web/orders` moves money.

**What I verified:**

- **Bind fix is real, not cosmetic.** `@hono/node-server` calls `server.listen(port, options.hostname, ...)` (`node_modules/@hono/node-server/dist/index.js:620`). Omitting `hostname` leaves Node to bind to the unspecified address (`::` / `0.0.0.0`), reachable from the LAN. Pre-fix the API literally was listening on all interfaces. The explicit `127.0.0.1` bind closes this. The thesis's framing as the "most important change" is correct.
- **CORS narrowing is real.** Pre-fix `origin` list included `https://app.oneoption.com`. That domain hosts the chat widget the user reads trades from; `ingest-backfill.ts` is the only endpoint that needs it. Granting it access to `/web/orders` via the global allowlist was a genuine exposure, not a hypothetical.
- **CSRF defense is not redundant.** I considered the argument that JSON body validation already implicitly blocks form-POST CSRF (forms send urlencoded, `validateBody` parses JSON and 400s). That is partially true, but `text/plain` simple-POSTs can carry JSON-parseable payloads without triggering preflight. `X-Requested-With` is the standard, cheap belt-on-top-of-braces. Not theatre.
- **Rate-limit path-scoping bug is real.** Empirically reproduced with Hono 4 (`node /tmp/hono-middleware-check.mjs`): `app.use('/web/orders', mw)` hits only the exact path. `PUT /web/orders/:id` and `DELETE /web/orders/:id` are NOT rate-limited — and both call `broker.modifyOrder`/`cancelOrder` (`web-orders.ts:244,274`). A single `app.use('/web/orders/*', rateLimiter(10))` covers both the bare path and `/:id` (also verified empirically). The thesis's required fix is correct; prefer the single-star form over keeping both lines.

**Where I softened the thesis:**

- `requireLocalhost` middleware is called "borderline theatre." I'd go further: it is effectively unreachable given the 127.0.0.1 bind (the TCP stack rejects non-loopback first). But it's 18 lines, well-tested, and costs nothing. Keep it as documentation of intent.
- Concern 4 (unbounded `Map` growth) is a non-issue as wired: `/web/orders` has no dynamic segments, and `/web/trades/*` resolves to `c.req.path` per request — for the endpoints that exist, the key space is bounded by route count, not by client input. If the fix widens to `/web/orders/*`, the map will include paths like `/web/orders/<uuid>`, unbounded in principle. In practice the live user has a handful of orders and this is never a leak worth worrying about. Worth a comment, not a blocker.

**Bottom line:** MERGE after tightening `/web/orders` to `/web/orders/*`. The thesis's required fix is necessary and correct; the rest of the verdict stands.
