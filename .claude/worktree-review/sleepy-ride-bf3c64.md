# sleepy-ride-bf3c64

## Goal

Tighten pre-live operational hygiene around (a) secret loading defaults, (b) the `secrets:list` CLI being correct, (c) running paper + live IBKR sidecars side-by-side without port collision, (d) gitignore that actually excludes all `.env*` files, and (e) avoiding leaking session/query-string PII in the ingestion browser logs.

## Changes

1. `.gitignore`: replaces `.env*.local` with `.env.*` and an `!.env.example` negation. Now `.env`, `.env.production`, `.env.foo` etc. are all ignored except the committed `.env.example`.
2. `src/lib/secrets/index.ts`: doc comment for `SECRET_PROVIDER` swapped so "keychain (default)" appears first. The runtime code already used `?? 'keychain'`; this is doc-only.
3. `src/lib/secrets/manage.ts`: `secrets:list` now iterates the canonical `SECRET_KEYS` array imported from `keychain-provider.ts` instead of re-parsing `.env` to discover what to check. Padding bumped 25 -> 30 to fit the longest key name.
4. `sidecar/scripts/start-sidecar.sh`: doc-only change. Header now states `SIDECAR_PORT` defaults to 8090 live / use 8091 for paper, with a worked example for running both simultaneously. The script body is unchanged - it still echoes `${SIDECAR_PORT:-8090}` in the startup line and never sets `SIDECAR_PORT` itself for `--paper`.
5. `src/lib/runtime-channels.ts`: paper sidecar default URLs flip from `:8090` to `:8091` for both HTTP and WS. Live unchanged at `:8090`.
6. `src/ingestion/browser.ts`: `console.log('[Browser] Landed on: ...')` now logs only `new URL(landingUrl).pathname` instead of the full URL. Strips query string + auth tokens from the log.

## Justification per change

- **(1) gitignore** - small, correct, pre-live appropriate. The previous pattern `.env*.local` only caught `.env.local`, `.env.production.local`, etc. A bare `.env.production` with secrets would have been committable. The `!.env.example` exception preserves the committed template. Necessary-ish.

- **(2) keychain default doc** - minor: the runtime code already defaulted to `keychain` (`?? 'keychain'`). This change only fixes the misleading docstring that said `"env" (default)`. Pure doc cleanup.

- **(3) SECRET_KEYS-driven list** - real bug fix. The old code tried to enumerate "what's in the keychain" by parsing `.env`. If you've migrated to keychain-only and deleted `.env`, `secrets:list` would `process.exit(1)`. Now it uses the same canonical key list `KeychainProvider.load()` already uses. Single source of truth. Good.

- **(4 + 5) two-sidecar story** - genuine pre-live concern. Today the runtime defaults both live and paper sidecars to `:8090`, so if both are enabled in `ENABLED_CHANNEL_IDS` the second config silently overlays the first (both point at the same Java process). Splitting paper to `:8091` makes simultaneous live+paper feasible. **However the implementation is half-finished** (see Concerns).

- **(6) browser landing log** - defensible. Auth providers (especially the trial-rotation Gmail/iCloud flow used here) often round-trip OAuth tokens or session cookies through query strings. Logging only `pathname` removes that surface. Cheap PII/secret hygiene.

## Concerns

- **(4 + 5) two-sidecar story is incomplete - the most load-bearing change in the patch and it does not actually work end-to-end.**
  - `start-sidecar.sh` body did NOT change. It still echoes `${SIDECAR_PORT:-8090}` and `--paper` does not set `SIDECAR_PORT=8091` - only `IBKR_GATEWAY_PORT=4002`. The header doc now says "default 8091 for paper" but the script doesn't enforce it. A naive operator running `./start-sidecar.sh --paper` (as `install-launchd.sh` does) gets a paper sidecar on `:8090`, which now mismatches the new TS default of `:8091` for paper. Ingestion would point at `:8091` (no listener); the launchd-installed sidecar would sit on `:8090`. Worse than before for the project's current default install path.
  - `scripts/install-launchd.sh:95` still says `IBKR sidecar (port 8090)` and runs the script with `--paper`. Not updated.
  - `web/src/views/architecture/data.ts:102` still says `Java sidecar :8090`.
  - `src/broker/select.ts:19` and `scripts/dev-up.ts:255` still hardcode `:8090` as their fallback (used when a runtime def has no `sidecarUrl`).
  - No `.env.example` update teaching the operator that paper now wants `IBKR_PAPER_SIDECAR_URL=http://localhost:8091/api`.
- **No tests touched.** CLAUDE.md explicitly warns "Secrets changes that don't have a test are scary." Both `manage.ts` (list path) and `runtime-channels.ts` (the foundational channel-scope abstraction) lack even a smoke test of the new behavior. The `manage.ts` change in particular re-imports `SECRET_KEYS` from `./keychain-provider.js` - if a future refactor moves that constant, the CLI silently loses keys and there is no test to catch it.
- **`SECRET_KEYS` includes keys with no consumers in `src/`.** `GMAIL_EMAIL`, `GMAIL_PASSWORD`, `ICLOUD_EMAIL`, `ICLOUD_APP_PASSWORD`, `HISTORICAL_DB_URL` appear only in the `SECRET_KEYS` literal; nothing reads `process.env.GMAIL_EMAIL` etc. anywhere in `src/`. Not this patch's bug, but the patch leans harder on `SECRET_KEYS` being canonical, so the cruft is now louder.
- **Browser log scrubbing is partial.** Only the landing-URL log is sanitized; `console.log('[Browser] Navigating to ${CHAT_URL}...')` four lines above logs the full URL (low risk - it is from env - but inconsistent), and other ingestion logs may leak too. Better than nothing, but the rule is not enforced consistently.
- **No author lesson file.** CLAUDE.md mandates `docs/lessons/YYYY-MM-DD-<slug>.md` per session; this worktree did not produce one. The intent of the patch has to be reverse-engineered.
- **Rails compliance:** OK. No `if (isBacktest)` introduced. Channel-scoping semantics (`ibkrChannel('paper', accountId)` -> `ibkr:paper:<acct>`) are unchanged - only the sidecar URL field on the runtime descriptor moved. Channel IDs themselves are untouched. Single-user appropriate, no new abstractions.
- **Typecheck passes** (`npx tsc --noEmit` clean in the worktree).

## Verdict: REWORK

The patch contains four small wins (gitignore, secrets:list bug fix, docstring fix, browser log scrub) that should ship, plus one ambitious change (paper sidecar on `:8091`) that is dangerously half-done. As-is, anyone who runs `scripts/install-launchd.sh` after merging will get a sidecar listening on `:8090` while ingestion expects `:8091` - i.e. the patch breaks the project's documented install path for the sake of an unrealized "run two sidecars simultaneously" feature. The TS default and the shell default disagree, which is exactly the split-source-of-truth this codebase's rails warn against. The remaining changes are correct but not on a critical pre-live path - secrets:list was already broken pre-patch and live trading does not exercise it. None of the changes have tests, which on the foundational `runtime-channels.ts` is uncomfortable.

Send back for tightening - the bundle is mostly right but the one piece that matters most for going live actively regresses.

## Required fixes

1. **Make the paper port story consistent or revert it.** Either:
   - **(a)** In `start-sidecar.sh`, set `SIDECAR_PORT="${SIDECAR_PORT:-8091}"` inside the `--paper` branch (same shape as `IBKR_GATEWAY_PORT`), update `scripts/install-launchd.sh:95` text, update `web/src/views/architecture/data.ts:102`, and add the two `IBKR_PAPER_SIDECAR_*=...:8091/...` entries to `.env.example`. OR
   - **(b)** Revert the `runtime-channels.ts` paper defaults back to `:8090` and keep just the doc-comment in `start-sidecar.sh` as "if you want to run both, override `SIDECAR_PORT` and the env URLs". Single-user, paper-only-today install is unaffected.
2. **Add a smoke test.** A trivial vitest that asserts `SECRET_KEYS` is what `secrets:list` consumes (so a future move breaks the test, not the CLI), and that `getRuntimeChannelDefinitions()` produces distinct sidecar URLs when both live and paper accounts are set.
3. **Author the lesson file** at `docs/lessons/2026-04-24-secrets-and-paper-sidecar.md` per project policy.
4. **(Optional)** Sweep the rest of `src/ingestion/browser.ts` for other URL-logging sites and apply the same pathname-only treatment, or factor a `logUrlPath()` helper so the rule is in one place.
5. **(Optional)** Prune `SECRET_KEYS` to keys that actually have consumers (or grep-confirm the dormant ones are read elsewhere) so the `secrets:list` output is honest.

## Reviewer verdict

**REWORK.** Concur with thesis after independent falsification pass.

**Agreements (verified against source in worktree):**
- Paper-sidecar regression is real and load-bearing. `sidecar/scripts/start-sidecar.sh:18-23` `--paper` branch sets only `IBKR_GATEWAY_PORT`, never `SIDECAR_PORT`; line 37 still echoes `${SIDECAR_PORT:-8090}`. TS default in `src/lib/runtime-channels.ts:56-57` now expects `:8091`. `scripts/install-launchd.sh:64-66` runs `start-sidecar.sh --paper` with only `IBKR_GATEWAY_PORT=4002` in its plist `EnvironmentVariables` — confirmed the launchd-installed sidecar lands on `:8090` while ingestion dials `:8091`. Stale `8090` sites confirmed at `scripts/dev-up.ts:255`, `src/broker/select.ts:19`, `src/lib/healthcheck.ts:4`, `web/src/views/architecture/data.ts:102`, `scripts/install-launchd.sh:95`, plus `src/broker/ibkr/client.ts:4` doc comment.
- Keychain-primary contract preserved: `secrets/index.ts:9,24` both default `'keychain'` (runtime behavior unchanged; only the docstring caught up to reality). Fallback order intact via `if (!(key in merged))` and `process.env[key] === undefined` guards. `ANTHROPIC_USE_SUBSCRIPTION=1` special-case still deletes `ANTHROPIC_API_KEY` after merge.
- `secrets:list` fix is correct. `SECRET_KEYS` is re-exported from `secrets/index.ts:5`; `manage.ts` import is stable. No longer hard-exits when `.env` is absent.
- Channel-scoping semantics unchanged. `ibkrChannel('paper', accountId)` still produces `ibkr:paper:<acct>`; only `RuntimeChannelDefinition.sidecarUrl` default moved. No `channelId` value drift anywhere — high-blast-radius abstraction is safe.
- `.gitignore` `.env.*` + `!.env.example` strictly tighter than prior `.env*.local`. Closes the `.env.production` commit hole.

**Disagreements / falsifications of thesis nits:**
- Thesis lists `ICLOUD_EMAIL`/`ICLOUD_APP_PASSWORD` as dormant. False — `src/ingestion/account-rotation.ts:180-183` actively reads both. Only `GMAIL_EMAIL`, `GMAIL_PASSWORD`, `HISTORICAL_DB_URL` are truly orphaned. Cruft is narrower than claimed.
- Browser scrub is even more partial than thesis flags: `src/ingestion/browser.ts:97` (`Policies accepted — now on: ${p.url()}`) logs the full post-redirect URL, same leak shape as the landing log. Reinforces (does not weaken) the "partial scrub" verdict.

**Missed by thesis:**
- `src/lib/healthcheck.ts:4` (`DEFAULT_SIDECAR_URL = 'http://localhost:8090/api'`) is a sixth stale `:8090` reference not enumerated in thesis required-fixes. Healthcheck against the wrong port post-merge.
- `src/broker/ibkr/client.ts:4` doc comment still says "localhost:8090". Cosmetic.

**Not verified, taken on trust:** `tsc --noEmit` clean.

**Verdict:** REWORK. Required fix #1 (paper-port consistency or revert) is mandatory; healthcheck.ts adds to the stale-site list. The other four wins (gitignore, secrets:list, doc, partial browser scrub) are correct and shippable. Tests + lesson file warranted given foundational `runtime-channels.ts` blast radius.
