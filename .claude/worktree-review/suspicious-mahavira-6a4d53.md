# suspicious-mahavira-6a4d53 — Market Guard / RTH / Halt Detection

## Goal

Prevent the live bot from submitting orders outside regular trading hours (RTH) or while a symbol is halted. Add a `MarketGuard` that gates OPEN signals on NYSE session state (pre / regular / post / holiday) and blocks all signals on symbols flagged as halted. Integrate it into the pipeline executor.

## Changes

- `src/lib/et-date.ts` — new `MarketSession` type and `getMarketSession(d)` function; added 2027 NYSE holidays and early-close days.
- `src/lib/halt-tracker.ts` — new `HaltTracker` class: in-memory `Map<symbol, expiryMs>`, default 15-min TTL, case-insensitive, self-pruning on read.
- `src/lib/halt-tracker.test.ts` — 8 tests covering mark/isHalted/expiry/reset/prune.
- `src/lib/market-guard.ts` — new `MarketGuard` class: composes HaltTracker + clock; halted symbols block all signals; non-halted outside-RTH blocks only OPEN/ADD (position-reducing bypasses session check).
- `src/lib/market-guard.test.ts` — 26 tests: holidays, weekends, early-close boundary, pre/post market, halt, 2027 holidays, session accessor.
- `src/pipeline/build-deps.ts` — instantiates `new MarketGuard(new HaltTracker(), clock)` unless `config.isBacktestScope` is truthy; pipes through `ResolvedPipelineDeps.marketGuard`.
- `src/pipeline/execute-resolved.ts` — adds `marketGuard?` to deps; calls `guard.checkSignal(symbol, isPositionReducing)` before the OPEN/reduce split; alerts on halt or holiday blocks. Also a catch-block regex scanner that looks for "halted" / "suspended" in thrown error strings and marks the symbol halted.
- `docs/lessons/2026-04-24-market-guard.md` — lesson file.

## Justification per change

- **`getMarketSession` / 2027 calendar** — correct and needed. 2027 calendar is authoritative (MLK, Good Friday, Juneteenth, July 5 Mon observation, Thanksgiving, Dec 24 Friday observation all check out). The type/function are small and purely additive.
- **HaltTracker** — fine as a data structure: simple map, TTL, no I/O. Its *content* is the problem (see Concerns).
- **MarketGuard.checkSignal** — clean composition. The "position-reducing bypasses session check" rule is correct per project policy (exits must always be allowed).
- **Pipeline integration at `execute-resolved.ts` line 493** — placed after the execution log line and before both OPEN and reduce paths. Correct spot for a single-point guard.

## Concerns

### 1. Backtest will silently run under the guard (bug)

The factory at `build-deps.ts:168` gates guard creation on `config.isBacktestScope`. But the **backtest runner never sets `isBacktestScope: true`** — see `src/backtest/runner.ts:205-219`. Only `live/runner.ts` references it (as `false`). Grep confirms no `true` setter exists anywhere. So the guard IS instantiated in backtest, and OPEN signals replayed at pre-market or post-market historical timestamps will now be blocked, silently changing backtest results vs. what the code ran at before. The author's lesson file explicitly claims "The guard is backtest-transparent: `marketGuard` is `undefined` when `config.isBacktestScope` is true" — the claim is false because the flag is never set. Either plumb `isBacktestScope: true` into the backtest runner, or (better, per rubric) make the backtest broker honor the same guard.

### 2. Halt detection is string-regex on error messages (not a broker feed)

The rubric explicitly warned: "track halts from the broker feed, not synthesize them." The halt path at `execute-resolved.ts:707` is:

```
if (/trading halt|trading suspend|\bhalted\b|\bsuspended\b/i.test(errMsg))
```

Problems stacked:
- IBKR sidecar errors don't reliably carry a "halted" keyword. The sidecar throws `IBKR sidecar ${status}: ${text}` (client.ts:154), and IBKR halt states mostly come back as a *mapped OrderStatus* (`Cancelled`, `Inactive`, `ApiCancelled`) — returned as an `OrderResult`, not a thrown error. So the catch-block regex will frequently *not fire* on actual halts.
- The project already has system alerts that include the string "market data suspended" (client.ts:228) for competing-session errors. If any such error bubbles up inside the pipeline catch, `\bsuspended\b` will false-positive and mark `signal.legs[0]?.symbol` halted for 15 minutes. Bogus symbol rate-limit.
- `signal.legs[0]?.symbol ?? 'unknown'` — if the symbol fallback fires, the string `'UNKNOWN'` gets registered as halted. Pollution of the map.
- There is no integration with IBKR's real halt events: `tickGeneric` field 49 halt flag, `reqContractDetails.tradingHours`, or explicit halt codes (399, 201 families). The current design is a hopeful pattern-match, not a guarantee.

### 3. Rails concern: `deps.marketGuard?` is effectively an `isBacktest` branch

Rails.md:50 and `pipeline-execution.md` require differences between live and backtest to live in `BrokerService` implementations. The presence/absence of `marketGuard` on deps is set in the factory based on `isBacktestScope`. The check in `execute-resolved.ts:493` is technically a field-presence check, but the semantics match an `if (isBacktest)` branch — and it's in `src/pipeline/`, which rails lists explicitly as shared. The rubric's framing of this is: the backtest SimBroker should obey the same guards (shouldn't fill at 3 AM), so the guard belongs either (a) as a hard check that runs in both paths, or (b) inside the broker implementations. The current placement is the worst of both — sometimes-on, sometimes-off, right in the shared pipeline.

Note: `SimBroker.getOptionQuoteTime` already snaps out-of-hours requests to `lastMarketCloseUTC` (sim-broker.ts:442), which means backtest will happily "fill" an OPEN at a stale close-of-previous-day price for a message that arrived at 7 AM. This is a separate backtest realism bug that this PR arguably should have addressed when it introduced the live-only guard.

### 4. `clearHalt` is dead code

`HaltTracker.clearHalt` is implemented and unit-tested but has no caller anywhere in `src/`. The lesson file notes "no manual clear path exists in the UI yet" — confirming this is aspirational. Knip will flag it if called out; either wire it or remove it. Minor.

### 5. Tests are real ET dates but the DST test is thin

- The holiday and early-close test dates match real NYSE calendar entries (Christmas 2025, day-after-Thanksgiving 2025-11-28 1 PM close). Good.
- Good Friday 2027-03-26 is tested at 14:00 UTC, which is 10:00 AM EDT (DST started 2027-03-14). The DST assumption is asserted only implicitly — passing the test verifies the UTC→ET conversion is DST-aware for that one day. No explicit "spring forward" or "fall back" test (e.g. a 2026-03-08 02:30→03:30 transition sample, or a 2026-11-01 fall-back hour).
- No test that crosses a weekend-to-holiday-to-trading-day sequence, though the existing `getPreviousTradingDayKey` utility gets exercised elsewhere.
- Tests are real, not theatre — no obvious mock-what-you-test. Fine.

### 6. Minor: reason-string coupling

`execute-resolved.ts:497` uses `guard.reason.toLowerCase().includes('halt')` to decide between two alert titles. This couples the alerting logic to string text in `market-guard.ts`. If the reason copy ever changes (e.g., "circuit breaker" replaces "halt"), alert routing silently breaks. The `GuardResult` union should expose a discriminator field (`kind: 'halt' | 'session'`) instead of re-parsing the reason.

## Verdict

**REWORK.**

The direction is right and necessary for going live — RTH gating and halt protection are real pre-live concerns. The session/calendar module is clean and additive. But the PR doesn't hold together on three of the six rubric axes:

1. **Rails violation** — backtest runner never sets the flag the factory depends on, so the "backtest-transparent" design contract is broken at runtime. Live and backtest now execute different pipeline code via a conditional deps field — this is exactly the `if (isBacktest)` anti-pattern, just hidden behind a field-presence check.
2. **Halt theatre** — the halt tracker is fine, but how it gets populated isn't. Regex-on-error-message isn't a halt feed; it will under-fire on actual IBKR halts (which come back as mapped statuses, not thrown errors) and over-fire on unrelated "suspended" strings that already exist in the codebase. Worse: "unknown" can be marked halted.
3. **Theatre vs. real** — the lesson file oversells ("The guard is backtest-transparent") in a way that is literally incorrect given the runner config.

The session-gate portion (holiday/pre/post blocking of OPEN in live) is the safe, valuable 20% of this change and could merge with small fixes. The halt-detection portion needs either a proper broker-feed integration or to be removed until one exists. Shipping the regex version now creates a noisy, unreliable guard that operators will learn to ignore.

## Required fixes

1. **Decide the backtest story and implement it consistently.** Either:
   - (a) Set `isBacktestScope: true` in `src/backtest/runner.ts`'s `buildPipelineDeps` call, and document that backtest intentionally bypasses session gating. Update the lesson to say so.
   - (b) Better: run the guard in backtest too, and adjust SimBroker so it doesn't fill at stale `lastMarketCloseUTC` prices for out-of-hours requests. This matches the rubric intent ("backtest should obey the same guards") and closes the realism gap.
2. **Rip out or replace the regex halt detector.** Either:
   - Remove the catch-block regex entirely and ship only the session guard. Halt handling becomes a followup when a real broker-feed source exists.
   - Or consume IBKR's halt signal properly: either via sidecar-reported tick generic 49, or via a dedicated `BrokerService.isHalted(symbol)` method that the live IBKR impl implements against real data and SimBroker stubs to `false`. That would also let the guard live behind a single broker-agnostic check, consistent with rails.
3. **Fix the "unknown symbol" fallback.** If `signal.legs[0]?.symbol` is missing, skip the halt mark — do not register `'UNKNOWN'`.
4. **Discriminate `GuardResult`.** Add `kind: 'halt' | 'holiday' | 'session'` to the blocked variant and switch alert routing on it instead of `.includes('halt')`.
5. **Either wire or delete `HaltTracker.clearHalt`.** It is currently dead (knip will catch this on merge).
6. **Add at least one DST-transition test** — e.g., spring forward 2026-03-08, fall back 2026-11-01 — to prove `getMarketSession` is robust across the seam, not just on a single post-DST day.

## Reviewer verdict

**REWORK.**

### Agreements

- **Concern #1 verified.** `grep` of `isBacktestScope` confirms only `src/live/runner.ts:200` sets it (to `false`). `src/backtest/runner.ts:205-219` calls `buildPipelineDeps` with no `isBacktestScope` field, so `config.isBacktestScope` is `undefined` (falsy) — but the factory's ternary `config.isBacktestScope ? undefined : new MarketGuard(...)` instantiates the guard whenever the flag is anything but truthy. So in backtest, `marketGuard` is fully wired and `execute-resolved.ts:493` will block OPEN signals replayed at historical timestamps falling outside RTH. The lesson file's claim "backtest-transparent" is literally false. This is a real behavior change for backtests.
- **Concern #2 verified.** The IBKR client at `src/broker/ibkr/client.ts:228` already emits the string `"market data suspended"` for competing-session errors — `\bsuspended\b` will false-positive and pollute the halt map. No `tickGeneric` field 49 or contract-details halt integration exists. Halt feed is regex-on-error-string, not broker-feed.
- **Concern #3 verified.** `marketGuard?` field-presence in shared pipeline code is semantically an `if (isBacktest)` branch in `src/pipeline/`, contrary to rails. Backtest's SimBroker `getOptionQuoteTime` (`src/backtest/sim-broker.ts:441-442`) does snap to `lastMarketCloseUTC` for out-of-hours requests, confirming the realism gap noted.
- **Concern #4 verified.** No callers of `HaltTracker.clearHalt` outside its unit test — knip-bait.
- **Concern #5 verified.** Tests assert Good Friday 2027-03-26 at 14:00 UTC (10:00 EDT). DST is implicitly exercised but no spring-forward / fall-back boundary test exists.

### Disagreements

- None of substance. The thesis is accurate on every falsifiable claim. The only nuance: `isBacktestScope` being `undefined` (not `false`) in backtest is the precise mechanism — the wording "never sets the flag the factory depends on" is correct.

### Missed

- The catch-block halt path also fires `await emitter.emit('SETTLED', ...)` and `results.push(haltResult)` after a `markHalted` call — a second order failure in the *same* batch on the *same* symbol won't reach this branch because the guard now short-circuits at line 493. That's intended, but means the only path to register a halt is the very first failing order in a batch. Single-attempt halt registration is a design decision worth surfacing.
- `MarketGuard.markHalted` is exposed but only used via the catch-block regex path; no test verifies that the executor actually calls it on rejection (integration coverage gap).
- The guard runs *after* a long synchronous chain (orchestrator resolution, exposure checks, etc.). Cheaper to gate earlier — by the time we hit line 493, we've already done substantial work for a signal that will be dropped.

### Verdict

REWORK matches the evidence. Session-gate slice is shippable with the `isBacktestScope` plumbing fix and a discriminated `GuardResult`. The regex halt detector should be removed or replaced with a `BrokerService.isHalted(symbol)` interface method (live impl uses real IBKR signals; SimBroker returns `false`) — that placement keeps rails clean and removes the false-positive risk from the existing `"suspended"` string in `client.ts:228`.
