# Paper → Live Config Audit (IBC + Launcher)

## Problem

Today's first live cutover (paper → `pykeswims` / `U14368257`) burned ~30 minutes on a misleading failure mode: gateway logged into live correctly, but the sidecar looped on `502 Couldn't connect to TWS` for the entire window. Login was healthy, the API socket was on the wrong port. Two pieces of state outside this repo were silently overriding the orchestrator's flip:

1. `~/ibc/config.ini` — read by `dev-up.ts` at `scripts/dev-up.ts:376-384`, never written by anything in this codebase. Anything paper-specific in that file (login, password, mode, API port override) survives an `ENABLED_CHANNEL_IDS` change and quietly corrupts the live session.
2. `~/ibc/gatewaystartmacos.sh:23` — IBC's launcher had `TRADING_MODE=paper` hardcoded, overriding the env var passed by `dev-up.ts:391`. Repo-side env was correct; IBC ignored it.

Net effect today: gateway authed `U14368257`, sidecar hit handshake timeouts, supervisor never noticed because `pgrep` saw a live process. Jason also missed two of three 2FA pushes recovering from it.

## Decision

Document the four IBC config fields that must flip with every paper ↔ live cutover, the launcher-script line that must stay env-driven, and the canonical order of operations. Patch `gatewaystartmacos.sh:23` to `TRADING_MODE=${TRADING_MODE:-paper}` so the env var from `dev-up.ts` actually wins. No repo code changes — the trap lives in unmanaged user state under `~/ibc/`.

## Key Files

- `scripts/dev-up.ts:376-384` — only place that reads `~/ibc/config.ini`. There are zero write paths in `scripts/`, `src/`, `sidecar/`, or `gateway/`. Confirmed by grep.
- `scripts/dev-up.ts:391` — passes `TRADING_MODE` env into the IBC launcher.
- `scripts/dev-up.ts:398` — sidecar API port selection (`4001` for live, `4002` for paper).
- `~/ibc/config.ini` — not version-controlled. Holds `IbLoginId`, `IbPassword`, `TradingMode`, `OverrideTwsApiPort`, `TWOFA_TIMEOUT_ACTION`.
- `~/ibc/gatewaystartmacos.sh:23` — patched today. Backup at `~/ibc/gatewaystartmacos.sh.bak.2026-04-26`. Could be overwritten by an IBC update or reinstall.

## The Trap: `OverrideTwsApiPort`

This is the specific field that bit today. It forces a single API port regardless of `TradingMode`. If left at `4002` during a live flip:

- IBC logs in to live correctly (`Setting Trading mode = live`, `Click button: Log In`).
- API socket opens on `4002` (paper port).
- Sidecar correctly picks `4001` for live (`scripts/dev-up.ts:398`) and gets `502 Couldn't connect to TWS` forever.
- Login looks fine in logs; supervisor's `pgrep` check sees the gateway as healthy.

## Pre-Flip Audit Checklist (`~/ibc/config.ini`)

Paper → live: confirm or change every one. Reverse all four when flipping back.

- `IbLoginId=` → live user (`pykeswims`), not `simpykeswims`.
- `IbPassword=` → live password, not paper.
- `TradingMode=` → `live`, not `paper`.
- `OverrideTwsApiPort=` → `4001` for live, `4002` for paper. Or remove the line entirely and let IBC pick the mode default (more robust for future flips; explicit is fine if disciplined).

## Launcher Script Trap (`~/ibc/gatewaystartmacos.sh:23`)

- Was hardcoded `TRADING_MODE=paper`. Patched to `TRADING_MODE=${TRADING_MODE:-paper}`.
- Lives outside the repo, not version-controlled, and an IBC update or reinstall can overwrite it.
- If a future flip silently logs into the wrong mode despite repo env being correct, check this line first.
- Backup: `~/ibc/gatewaystartmacos.sh.bak.2026-04-26`.

## 2FA Timing

- IBC's push window is ~3 minutes.
- `TWOFA_TIMEOUT_ACTION=exit` is set in `config.ini` but did not fire on today's first attempt — IBC logged "Re-login after second factor authentication timeout not required" and went zombie (process alive, no API listener).
- Supervisor's `pgrep` check sees zombie as healthy. Recovery path is the sidecar supervisor's `Sidecar process unreachable` branch, which calls `startGatewayAndSidecar()`.
- Manual recovery: `kill <gateway-pid> <sidecar-pid>`. Expect ~30s monitor tick + 10s delay = ~40s before fresh push fires.
- Be phone-in-hand before kicking it. Missing the window forces another respawn cycle. Today: missed two of three pushes.

## Order of Operations — Clean Paper → Live Flip

1. `npm run secrets:set IBKR_LIVE_ACCOUNT_ID U…` if not already set.
2. Edit `~/ibc/config.ini`: flip `IbLoginId`, `IbPassword`, `TradingMode`, `OverrideTwsApiPort`.
3. Confirm `~/ibc/gatewaystartmacos.sh:23` is `TRADING_MODE=${TRADING_MODE:-paper}` (not hardcoded `paper`).
4. Force-signout target user on all other devices (mobile app, browser TWS, desktop TWS) to avoid TWS error `10197 "competing live session"`.
5. Kill paper orch, relaunch with `ENABLED_CHANNEL_IDS=ibkr:live:U… LIVE_TRADING_CONFIRMED=YYYY-MM-DD`.
6. Verify within 5 min: gateway listening on `:4001`, account summary returns `accountId: "U14368257"`, broker circuit breaker CLOSED, StopRecon reports zero open live trades on first sweep.

## Watch Out

- `~/ibc/config.ini` is read-only from this repo's perspective. There is no orchestrator codepath that templates or writes it. Treat it as deploy-time human config.
- The launcher-script line is the most dangerous because it silently overrides repo intent. Re-check `gatewaystartmacos.sh:23` after any IBC reinstall.
- Zombie gateway after 2FA timeout is invisible to the supervisor's process check. Trust the sidecar's `502 Couldn't connect to TWS` log, not `pgrep`.
- IBKR Mobile background sessions are the most common `10197` source and are not visible in `ps`. Force-signout from the phone, not just background.
- Phone in hand before any orch restart that touches IBC login.
