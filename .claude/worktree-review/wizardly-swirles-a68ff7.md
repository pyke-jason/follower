# Worktree audit: wizardly-swirles-a68ff7

## Goal

Pre-live safety hardening of the IBKR connection path: (a) refuse to declare the sidecar "ready" if it is connected to an account other than the one the orchestrator expects, (b) make the IBKR gateway port mandatory rather than silently defaulting to the live port (4001). Both are footguns that, in this single-user system, are the only thing standing between "paper run" and "live trade against the wrong account."

## Changes

1. `scripts/dev-up.ts` — `ChannelInfo` gains `ibkrAccountId`; `superviseSidecar` takes an `expectedAccountId` and treats `connected=true` as not-ready when `body.accountId !== expectedAccountId`. Also adds a runtime guard rejecting non-`paper`/`live` modes from `getRuntimeChannelDefinitions()`.
2. `sidecar/src/main/java/com/tradefollower/sidecar/TwsBridge.java` — `IBKR_GATEWAY_PORT` is now required at construction time; missing/blank throws `RuntimeException` with an explicit message.
3. `sidecar/src/main/java/com/tradefollower/sidecar/App.java` — `startHealthcheckPing` reads `IBKR_GATEWAY_PORT` without a default; comment explains "no default = ping disabled if absent, rather than acting as live."

## Justification per change

**dev-up account check.** Real. The sidecar already exposes `accountId` from `/api/status` (`App.java:43`, `TwsBridge.getAccountId()`). The orchestrator already knows the expected account because `runtime-channels.ts` requires `IBKR_LIVE_ACCOUNT_ID` / `IBKR_PAPER_ACCOUNT_ID`. Wiring those two together so "ready" requires account match is precisely the cheap, high-leverage check you want before going live. Live mis-routing to a wrong account is irreversible.

**dev-up mode runtime check.** Defensible. `RuntimeChannelDefinition.mode` is typed `'live' | 'paper'`, but `detectChannels` widens it to `mode?: string` for its local destructure, so the throw catches "future env-driven typo" rather than a current TS-prevented case. Mild belt-and-braces; cheap.

**TwsBridge required port.** Real, and the most important change. Previously a missing `IBKR_GATEWAY_PORT` silently meant `4001` (live). For a paper-by-default development workflow, that default is exactly backwards — failing closed is correct. All known callers (`start-sidecar.sh`, `dev-up.ts` line 401, `install-launchd.sh`) already export an explicit value, so this is non-breaking.

**App.java ping default removal.** Theoretical safety only. `App.java:30` constructs `new TwsBridge(...)` at startup; if `IBKR_GATEWAY_PORT` is missing, the JVM dies before `startHealthcheckPing` is reached. The comment correctly documents the intent ("disables pings rather than activating live") but the change is unreachable in practice. Harmless — it keeps the file consistent with the new contract and survives any future refactor that constructs the bridge lazily.

## Concerns

- `ibkrDefs[0]?.accountId` mirrors a pre-existing `ibkrDefs[0]?` pattern. If both `IBKR_LIVE_ACCOUNT_ID` and `IBKR_PAPER_ACCOUNT_ID` are exported and `ENABLED_CHANNEL_IDS` is unset, `runtime-channels.ts` returns both, and `[0]` (live) wins. The mode check is now stricter so this is louder than before, but it's a pre-existing subtlety the patch doesn't introduce or fix. Not a blocker.
- Account check is in `dev-up.ts` only. The runtime IBKR client (`src/broker/ibkr/`) doesn't enforce account match per request. A live-mode order placed against a sidecar that mid-session reconnected to a different account would still flow. The orchestrator-time gate prevents starting against the wrong account; it does not prevent mid-session account drift. Out of scope for this PR, worth a follow-up.
- No lesson file. `CLAUDE.md` mandates `docs/lessons/YYYY-MM-DD-slug.md` after implementation sessions; none of today's lessons cover this work. Minor process miss.
- No tests. Pure plumbing/safety; hard to unit-test meaningfully without a fake sidecar. Acceptable.

## Verdict: MERGE

These are exactly the kind of small, surgical, fail-closed changes that belong in a pre-live tightening pass. The wrong-account gate uses data the sidecar already exposes; the mandatory-port change converts a silent live-default footgun into a loud failure; the App.java tweak is consistent housekeeping. `tsc --noEmit` is clean. None of it is bloat or theatre — every change closes a specific footgun on the path to live trading. Ship it.

## Required fixes

None blocking. Optional follow-ups:

- Add a lesson file `docs/lessons/2026-04-24-sidecar-account-gate.md` documenting (Problem) live-default port + no account verification, (Decision) fail-closed in dev-up + required env in TwsBridge, (Key Files) `scripts/dev-up.ts`, `sidecar/.../TwsBridge.java`, (Watch Out) gate is start-time only, not per-request.
- Hoist the account-match check into the IBKR broker client so it survives mid-session sidecar reconnects, not just orchestrator startup.

## Reviewer verdict

**APPROVE**

### Agreements

- **Sidecar account check is real and high-leverage.** Verified `App.java:43` exposes `accountId` via `/api/status`, `TwsBridge.getAccountId()` (line 275) returns the captured managed account, and `runtime-channels.ts` already plumbs `accountId` from `IBKR_LIVE_ACCOUNT_ID`/`IBKR_PAPER_ACCOUNT_ID` (lines 35–54). Wiring is sound; the new `body.accountId !== expectedAccountId` gate is applied in both the supervise-loop's `isReady` and the post-launch `waitForHealth` check. Symmetric, fail-closed.
- **Required `IBKR_GATEWAY_PORT` in TwsBridge is the right call.** The previous `getOrDefault(..., "4001")` was a live-default landmine. Confirmed all callers already export the var: `start-sidecar.sh:15-18` defaults per `--paper` flag, `dev-up.ts:400` passes `gwPort`, `install-launchd.sh:69` sets it. Non-breaking.
- **App.java healthcheck-ping change is housekeeping but harmless.** Thesis correctly notes `new TwsBridge(...)` at `App.java:30` aborts JVM startup before `startHealthcheckPing` runs — so the removed default is unreachable today. Keeping the file consistent with the new contract is fine.
- **Mode runtime guard is cheap belt-and-braces.** `RuntimeChannelDefinition.mode` is typed `'live' | 'paper'`, but the local destructure widens to `mode?: string`, so the throw is defensive against future env-driven typos.
- **`tsc --noEmit` passes** on the worktree.

### Disagreements

None substantive. The thesis's self-noted concerns (mid-session account drift, missing lesson file, no tests) are correctly framed as out-of-scope or low-cost.

### Missed

- The new `superviseSidecar` signature now requires `expectedAccountId: string`, but if `IBKR_LIVE_ACCOUNT_ID`/`IBKR_PAPER_ACCOUNT_ID` is unset, `ibkrAccountId` falls back to `''` and the `if (expectedAccountId && ...)` guard is skipped — meaning the safety check silently no-ops in environments without an account env var. That is intentional fail-soft for dev (sidecar still works without an account hint) but contradicts the "fail-closed" framing for the live path. Pre-live deployments should additionally require `IBKR_LIVE_ACCOUNT_ID` to be set before `mode === 'live'` proceeds. Worth a follow-up assertion in `detectChannels` or `superviseSidecar`: when `mode === 'live'` and `expectedAccountId === ''`, throw.
- `runtime-channels.ts` already requires `IBKR_LIVE_ACCOUNT_ID`/`IBKR_PAPER_ACCOUNT_ID` to construct the def, so in practice an empty string here would only occur if someone sidesteps that path — but the type allows it (`accountId?: string` in `dev-up.ts`'s local destructure), so the bypass is reachable on refactor.

### Verdict

Surgical, narrow, each change tied to a real footgun on the live-trading path. Ship it. Optional follow-up: tighten the empty-`expectedAccountId` case for `mode === 'live'`.
