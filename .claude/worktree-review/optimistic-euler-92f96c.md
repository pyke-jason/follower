# optimistic-euler-92f96c

## Goal
Add a manual kill switch so the operator can (a) stop the bot from placing new orders, (b) cancel all working IBKR orders globally, and (c) optionally market-close all open positions. Surfaced via both a CLI (`pnpm halt` / `pnpm resume`) and a local-API admin route (`GET/POST/DELETE /admin/halt`).

## Changes
1. `src/lib/halt-state.ts` (new) — File-backed flag at `data/trading.halt` with `isHalted/readHaltState/setHalt/clearHalt` and `HaltState = { haltedAt, reason, triggeredBy: 'cli'|'api'|'system' }`.
2. `src/lib/errors.ts` — new `TradingHaltedError` class.
3. `src/orders/order-manager.ts` — `OrderManager` gains optional `haltCheck?: () => boolean`; `submitOrder()` throws `TradingHaltedError` when it returns true.
4. `src/pipeline/build-deps.ts` — wires `haltCheck: config.isBacktestScope ? undefined : isHalted`.
5. `src/broker/interface.ts` + all implementations — new `cancelAllOrders(): Promise<void>`. IBKR calls sidecar `DELETE /api/orders` + clears `creditComboOrderIds`. SimBroker/STUB no-op.
6. `sidecar/OrderRoutes.java` — new `DELETE /api/orders` → `reqGlobalCancel` with audit log.
7. `src/cli/halt.ts`, `src/cli/resume.ts` (new) — `pnpm halt` / `pnpm resume` entry points.
8. `src/local-api/routes/admin.ts` (new) — Hono router at `/admin`: `GET/POST/DELETE /halt`.
9. `src/index.ts` — boot warns loudly + alerts if halt file exists; does NOT exit.
10. `src/orders/order-manager.halt.test.ts` (new) — 5 unit tests including real `isHalted` path.

## Justification per change
- **Necessary for going live (yes).** Manual kill switch is table-stakes for autonomous trading.
- `TradingHaltedError` dedicated class — retry wrappers / callers can classify as hard-stop.
- `cancelAllOrders` on `BrokerService` — correct location, one primitive shared across implementations.
- File-backed flag — right choice for multi-process (CLI + API server), single-user Mac. No Redis/DB needed.
- Tests exercise real wiring (`isHalted` imported from real module) — not mock theatre.

## Concerns

### 1. Backtest runner does NOT set `isBacktestScope` — halt state leaks into backtests (CORRECTNESS BUG)
`src/backtest/runner.ts:205` calls `buildPipelineDeps({...})` without passing `config.isBacktestScope`. In `build-deps.ts:109`, `config.isBacktestScope ? undefined : isHalted` therefore wires `isHalted` for backtests too. Since halt state is a global file, **halting live trading will also block all subsequent backtests**. Only `src/live/runner.ts:200` sets `isBacktestScope: false` explicitly — neither backtest site does. This is the exact "pipeline has an isBacktest-style leak" violation the rails warn against, pushed upstream to a config flag.

### 2. CLI + admin route duplicate the same logic
`closePosition()` helper spelled out verbatim in `src/cli/halt.ts` lines 30-67 AND `src/local-api/routes/admin.ts` lines 23-61. The alert, cancel-all loop, "if already halted" guard — duplicated. For a single-operator system, CLI + admin route are redundant. Either drop one, or extract a shared `haltAllBrokers(source, brokerMap)` helper that both call.

### 3. Halt does not block direct `broker.placeOrder()` sites
Halt only gates `OrderManager.submitOrder()`. These bypass it:
- `src/local-api/routes/trades.ts:37` (`force-exit`)
- `src/local-api/routes/web-orders.ts:180` (web trim/close)

The UI/CLI close paths bypassing is likely desired (you halt the bot but still want to force-exit a position), but it's undocumented. One-line comment needed so it's a choice, not an oversight.

### 4. No auth on admin route — acceptable for localhost
Fine for single-user localhost. Worth noting: CORS in `server.ts:36` allows `https://app.oneoption.com` — if that page ever posts to `localhost:3791/admin/halt`, a compromised origin could DoS-halt trading. Low risk today; document-worthy.

### 5. Minor: halt file path bypasses `PATHS`
`halt-state.ts` constructs `resolve(PROJECT_ROOT, 'data', 'trading.halt')` inline rather than extending `src/lib/paths.ts` `PATHS.haltFile`.

### 6. Missing lesson file
CLAUDE.md mandates a `docs/lessons/YYYY-MM-DD-*.md` per session. None covers kill switch.

## Verdict
**REWORK.** Core primitive is well-designed: file-backed state, `TradingHaltedError` as a distinct signal, `cancelAllOrders` correctly upstream on `BrokerService`, `reqGlobalCancel` as the right IBKR primitive, and tests hit the real `isHalted` path. This is real, not theatre. But it ships three unforced concerns: (1) backtests will incorrectly inherit the halt because `isBacktestScope` isn't plumbed through `backtest/runner.ts`, (2) CLI and admin route duplicate `closePosition` + alert + loop logic verbatim, and (3) the single-user rubric doesn't need both a CLI and an admin route — pick one. Fix the backtest leak (correctness) and collapse the duplication; the feature stays.

## Required fixes
1. **Stop backtest from inheriting halt.** Preferred: change `build-deps.ts:109` to derive backtest-ness from scope: `haltCheck: scope.startsWith('bt:') ? undefined : isHalted` (factory already knows scope; removes the flag). Alternative: set `isBacktestScope: true` in `src/backtest/runner.ts:211`.
2. **Deduplicate CLI vs admin route.** Extract `haltAllBrokers({ reason, triggeredBy, closeAll, brokerMap })` into a shared helper. Delete the duplicated `closePosition`.
3. **Pick CLI or admin route.** Recommendation: keep CLI (works when local-api is down — exactly when a kill switch matters), drop admin route. If dashboard needs it, CLI shells out to `curl`.
4. **Add `haltFile` to `src/lib/paths.ts`** and import it in `halt-state.ts`.
5. **Document bypass.** One-line comment above `submitOrder()`'s halt check: halt gates signal-driven orders only; UI/CLI closes bypass by design.
6. **Write the lesson file** — `docs/lessons/2026-04-24-kill-switch.md`.

## Reviewer verdict

**REWORK.** Thesis is solid; primary correctness concern verified.

### Agreements

- **Backtest leak is real.** `src/backtest/runner.ts:205-219` calls `buildPipelineDeps` with no `isBacktestScope` field. In `build-deps.ts:109` the ternary `config.isBacktestScope ? undefined : isHalted` evaluates `undefined ? ... : isHalted` = `isHalted`. SimBroker order placement during backtest will throw `TradingHaltedError` whenever `data/trading.halt` exists. Only `live/runner.ts:200` sets the flag explicitly. Bug confirmed. The proposed fix (derive from `scope.startsWith('bt:')`) is cleaner — the flag is redundant with scope and ripe for the same drift in future runners.
- **CLI/admin duplicate is verbatim.** `diff` of `cli/halt.ts:30-67` vs `admin.ts:23-61` shows a single-line difference (one comment in admin.ts). Even the `pos.symbol.split(' ')[0] ?? pos.symbol` underlying derivation is duplicated. `cancelAllOrders` loop and `sendSystemAlert` payload also near-duplicated. Worth extracting.
- **Halt only gates `OrderManager.submitOrder`.** Confirmed via grep: `haltCheck` only referenced at `order-manager.ts:52`. Direct `broker.placeOrder` sites at `trades.ts:37` (force-exit), `web-orders.ts:180`, and the kill-switch's own `closePosition` helpers all bypass. Worth a comment.
- Halt-state tests include a real-wiring path (`makeOrderManager(isHalted)` after `setHalt`), not pure mocks. Quality holds up.

### Disagreements / nuance

- **Concern #3 framing is half-wrong.** The kill-switch's *own* `closePosition` helpers MUST bypass the halt — they execute *because* the halt was just set. That's not undocumented; it's structurally necessary (set flag, then close). The undocumented bypass is `trades.ts`/`web-orders.ts`. Comment belongs there, not in `OrderManager`.
- **"Pick CLI or admin route" recommendation is too strong.** Single-user, but: CLI runs when local-api is down (kill-switch's most-needed mode); admin route lets the dashboard show halt state and reuses already-running broker connections (CLI has to spin up its own via `getRuntimeBrokerMap`). They serve different failure modes. A shared helper resolves the duplication; both endpoints should remain.
- **`PATHS.haltFile` extraction is cosmetic noise.** The file lives in `data/`, the path is one line, `paths.ts` doesn't currently export per-file constants for similar files (e.g., `tick-cache.db`). Skip.

### Missed by thesis

- **`web-orders.test.ts` modified** but not called out. Worth a glance for whether it adapts to new `cancelAllOrders` on the broker interface or is unrelated.
- **`checkpoint-serialization.test.ts` modified** — likely SimBroker now has `cancelAllOrders` to mock; benign.
- **`OrderManager.haltCheck` typed `(() => boolean) | null` internally** but `?: () => boolean` externally — minor inconsistency, not a bug.
- **Boot warning at `index.ts:46-54` does not exit but also does not block** — this is intentional per the thesis, but operators expecting `npm run dev` to refuse to start while halted may be surprised. The `sendSystemAlert` is fire-and-forget (`void`) — fine.

### Verdict

REWORK. Ship the primitive; fix the backtest leak (single-line, correctness); collapse duplicate `closePosition` to a shared helper. Keep both CLI and admin route. Skip the `PATHS` cosmetic. Add a comment on the UI-bypass paths in `trades.ts`/`web-orders.ts`. Lesson file is mandatory per CLAUDE.md.
