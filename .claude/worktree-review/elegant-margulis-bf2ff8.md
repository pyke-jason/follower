# elegant-margulis-bf2ff8

## Goal
Dependency hygiene for go-live: patch known CVEs in the dep tree by bumping direct dependencies (`drizzle-orm`, `hono`, `@hono/node-server`, `vitest`, `vite`) and pinning transitive versions via `overrides` / `pnpm.overrides` (`undici`, `vite`, `picomatch`, `path-to-regexp`, `lodash`). Also removes the stale `web/package-lock.json` (web has been on `pnpm-lock.yaml` for a while). No source changes — pure dependency maintenance.

## Changes
- `package.json` — bump `@hono/node-server` 1.19.9 -> 1.19.14, `drizzle-orm` 0.45.1 -> 0.45.2, `hono` 4.11.9 -> 4.12.15, `vitest` 4.0.18 -> 4.1.5. Add top-level `overrides` pinning `undici ^7.25.0` and `vite ^7.3.2`.
- `web/package.json` — bump `vite` 6.0.0 -> 6.4.2. Add `pnpm.overrides` pinning `micromatch>picomatch`, `fdir>picomatch`, `recharts>lodash`, `router>path-to-regexp`.
- `web/package-lock.json` — deleted (10,550 lines). `web/pnpm-lock.yaml` is the canonical lockfile (web runs pnpm; `web/package.json` scripts use `pnpm run`).
- `package-lock.json`, `web/pnpm-lock.yaml` — regenerated to match above.

## Justification per change

- `drizzle-orm ^0.45.2` — **JUSTIFIED**. Patches GHSA-gpj5-g38j-94v9 (HIGH: SQL injection via improperly escaped SQL identifiers). Drizzle is the ORM for every write in `src/db/`; directly exploitable if any query builder encounters attacker-influenced identifier strings. Minimal patch bump.
- `hono ^4.12.15` — **JUSTIFIED**. Patches a stack of moderate advisories (prototype pollution in `parseBody({dot:true})`, cookie validation, `serveStatic` middleware bypass, jsx HTML injection, IP-match bypass). Local API is loopback-only so exposure is low, but hono is production code and the fix is a compatible minor bump.
- `@hono/node-server ^1.19.14` — **JUSTIFIED**. Patches GHSA-92pp-h63x-v22m (serveStatic middleware bypass). Trivial patch bump.
- `vitest ^4.1.5` — **SUSPECT**. Test-only dependency; no CVE driving this specific bump. Likely incidental (pulled in by lockfile regeneration). Harmless but not "necessary for go-live"; adds delta without reducing real risk.
- Root `overrides: { undici ^7.25.0, vite ^7.3.2 }` — **JUSTIFIED**. `undici 7.0-7.23` has 6 advisories including HIGH CRLF injection and DoS; arrives transitively via `cheerio` (used in `src/parsing/*.ts`). `vite 7.0-7.3.1` has HIGH path traversal / fs.deny bypass / dev-server WebSocket file read; arrives via `vitest`. Override pin is the right mechanism since both are transitive.
- `web/package.json vite ^6.4.2` — **JUSTIFIED**. Direct dep bump; same vite CVE class (path traversal in optimized deps, fs.deny bypass). Affects the dev server developers run daily.
- `web/package.json pnpm.overrides` — **MOSTLY BLOAT**.
  - `micromatch>picomatch ^2.3.2` and `fdir>picomatch ^4.0.4` — `pnpm why picomatch` shows both copies resolve only through `shadcn` (dev CLI tool) and `@dotenvx/dotenvx` inside shadcn. No production bundle path.
  - `router>path-to-regexp ^8.4.2` — resolves only through `shadcn>@modelcontextprotocol/sdk>express>router`. shadcn is a devDependency CLI.
  - `recharts>lodash ^4.18.1` — `recharts` is a runtime production dep (used in dashboard charts). This is the only override that actually hits deployed code. JUSTIFIED in principle, but version `4.18.1` is unusual — mainline lodash is `4.17.x` (current `4.17.21`). Worth confirming not a typo.
- `web/package-lock.json` deletion — **JUSTIFIED**. web is a pnpm project (scripts use `pnpm run`, `web/pnpm-lock.yaml` is current). The orphaned npm lockfile was already marked deleted in main's working tree. Cleans up confusion.
- `package-lock.json` regeneration — **JUSTIFIED**. Consequence of the dep bumps.

## Concerns

- **Bloat**: The `web/package.json` pnpm overrides targeting `picomatch` and `path-to-regexp` only patch `shadcn`'s transitive tree. `shadcn` is a dev CLI tool (never bundled, never run against untrusted input). The overrides add maintenance overhead for zero production risk reduction. Only `recharts>lodash` hits actual runtime.
- **Suspect version pin**: `recharts>lodash: ^4.18.1` (web/package.json:62). lodash's canonical release line is `4.17.x` (`4.17.21` latest). `4.18.1` resolves on npm but isn't the mainline. Verify this is the intended advisory fix.
- **Suspect / unnecessary surface**: `vitest 4.0.18 -> 4.1.5` (package.json:57) is not driven by any listed CVE; pure version drift.

## Verdict
**MERGE** (with optional cleanups). The high-severity fixes (`drizzle-orm` SQL injection, `undici` CRLF injection, `vite` path traversal) are exactly the pre-live dependency hygiene that belongs in a go-live worktree. Rails are untouched, no source files change, all 565 tests pass, `npm --prefix web run check` succeeds, backend `tsc --noEmit` is clean. Main goes from 11 advisories (4 high / 7 moderate) to 4 moderate (all remaining are `drizzle-kit`'s ancient `@esbuild-kit/*` dev-only chain — orthogonal to this worktree). The shadcn-targeted pnpm overrides are bloat but low-cost bloat; not worth blocking on.

## Required fixes (if REWORK or BLOCK)
N/A — MERGE. Optional cleanups the author could address post-merge:
1. Verify `recharts>lodash: ^4.18.1` is intentional (not a typo for `^4.17.21`); if there's no lodash advisory in recharts's tree justifying it, drop the override.
2. Consider dropping the `micromatch>picomatch`, `fdir>picomatch`, `router>path-to-regexp` pnpm overrides — they only affect the `shadcn` dev CLI tree and add no runtime safety.
3. The `vitest` bump is incidental; future dev-tool bumps belong in a separate audit cadence.

## Reviewer verdict

**MERGE.** Tried to falsify; thesis holds on every substantive claim.

**Verified:**
- Worktree diff is exactly as advertised: `package.json`, `web/package.json`, both lockfiles, and `web/package-lock.json` deletion. No source changes.
- No major-version bumps. `@hono/node-server` 1.19.9→1.19.14 (patch), `drizzle-orm` 0.45.1→0.45.2 (patch), `hono` 4.11.9→4.12.15 (minor), `vitest` 4.0.18→4.1.5 (minor), `web` `vite` 6.0.0→6.4.2 (minor). All semver-safe.
- Root `overrides` do bite: `package-lock.json` resolves `undici@7.25.0` and `vite@7.3.2` as advertised.
- `web/package-lock.json` deletion is safe: root `"web"` script is `cd web && pnpm dev`, `build` is `cd web && pnpm build`, `web/package.json` `check` script uses `pnpm run`. `web/pnpm-lock.yaml` is the canonical lockfile and is regenerated in the diff. The orphan npm lockfile was already marked deleted on `main`'s working tree.
- `npx tsc --noEmit` clean; `pnpm run build` in `web/` succeeds.
- `recharts>lodash: ^4.18.1` resolves: thesis flagged this as suspect, but `lodash@4.18.1` does exist on the npm registry (latest, published after 4.17.21) and `pnpm why lodash` shows the one installed copy in `web/` is `4.18.1` under `recharts@2.15.4`. The thesis's concern #1 is incorrect — this is not a typo, it's a real published version. Override works.

**Falsifying finding (minor):** Thesis claims `micromatch>picomatch` / `fdir>picomatch` only resolve under `shadcn` (dev CLI) and `@dotenvx/dotenvx` inside shadcn. `pnpm why picomatch` shows `picomatch@4.0.3` also lands via `vite@6.4.2` (through `tinyglobby` and `fdir`) — i.e. affects the dev server, not just shadcn. However, the override pin is `^4.0.4` and the resolved version is `4.0.3`, so the override isn't biting (no `4.0.4` published in a compatible range). Either way: picomatch in a dev/build path has near-zero real-world risk. Not a blocker.

**Not falsified:**
- `path-to-regexp` override only hits `shadcn>@modelcontextprotocol/sdk>express>router` tree — pure dev CLI. Thesis correctly labels as bloat.
- `vitest` bump is not CVE-driven. Harmless.

No rails violations (`docs/rails.md` untouched), no `if (isBacktest)` additions, no schema/migration concerns. Pure dependency maintenance appropriate for go-live.

**Verdict matches thesis: MERGE.** Optional cleanup: drop the shadcn-targeted pnpm overrides post-merge and either bump `picomatch` override to `^4.0.3` (so it actually pins) or drop it since the dev-path exposure is negligible.
