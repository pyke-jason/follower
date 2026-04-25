# Worktree audit: zen-proskuriakova-d3b267

## Goal
Add Pattern Day Trader (PDT) awareness to the pre-trade risk check. Two layers:
1. Hard block when IBKR's `AccountSummary.DayTradesRemaining` reports 0.
2. Optional "safe mode" that counts completed same-day round-trip closures from our own `trades` table over a rolling 5-trading-day window and refuses the would-be 4th day trade.
3. Non-blocking advisories for sub-$25K equity nearing PDT designation, and for cash accounts (T+2 settlement).

## Changes
- New `src/orders/pdt.ts` with `PDT_LIMIT=4`, `PDT_MIN_EQUITY=25_000`, `getPdtWindowStartKey()` and `countDayTradesInWindow()` (Drizzle SQL: counts CLOSED trades whose `opened_at::date AT TIME ZONE 'America/New_York' = closed_at::date AT TIME ZONE 'America/New_York'`).
- New `src/orders/pdt.test.ts` covering the window-start helper for Wed/Mon/Good-Friday/Fri starting points + checkRiskLimits PDT branches.
- `src/orders/risk-check.ts`: extends `RiskCheckConfig` with `pdtSafeMode?: boolean`; extends `RiskCheckDeps` with three new getters; adds early-return hard block when `dayTradesRemaining === 0`; adds safe-mode block when `dayTradesInWindow >= PDT_LIMIT-1`; adds two advisory `pdtWarning` paths.
- `src/broker/types.ts` + `src/broker/ibkr/schemas.ts` + `src/broker/ibkr/client.ts`: optional `accountType: 'MARGIN' | 'CASH' | 'PORTFOLIO_MARGIN'` on `AccountBalance`, populated from sidecar `accountType` string with mapping for "PORTFOLIO MARGIN" and "CASH".
- `src/config/risk-defaults.ts`: adds `pdtSafeMode: false` to both BACKTEST and LIVE defaults.
- `src/pipeline/build-deps.ts`: wires three new dep getters; `getDayTradesInWindow` calls `countDayTradesInWindow(scope, clock)`; `getDayTradesRemaining` and `getAccountType` call `broker.getAccountBalance()`.
- `src/pipeline/execute-resolved.ts`: emits a `log.warn` and `sendAlert` of severity `warning` when `risk.pdtWarning` is set.

## Justification per change
- **Hard block on 0 remaining:** Defensive. IBKR will reject anyway; pre-empting saves a sidecar round trip and gives a cleaner reason string. Necessary if ever running an account < $25K, harmless otherwise.
- **Safe mode counter:** A second-source check independent of IBKR's tag (in case the subscription is stale or `dayTradesRemaining` is missing). Off by default in both configs, so it ships dormant.
- **`accountType`:** The cash-account T+2 advisory hangs off this. Schema + client wired but the **Java sidecar (`sidecar/src/main/java/com/tradefollower/sidecar/AccountRoutes.java:44–53`) does NOT expose `accountType`** — the field will always be `undefined` until the sidecar is updated. So `accountType === 'CASH'` advisory is dead today.
- **Defaults `pdtSafeMode: false`:** Keeps the new gate dormant unless someone opts in. Matches "ship optional, opt in when needed."

## Concerns

### Necessity
The user is the project owner and runs autonomously. If the account is **above $25K equity**, IBKR returns `dayTradesRemaining = -1` (unlimited) and **none of this code fires** beyond a no-op early-return. The PDT rule is irrelevant. From `CLAUDE.md` and rails the account size isn't documented; the author hasn't justified this. If account ≥ $25K, this whole worktree is bloat.

If sub-$25K: only the hard-block-on-0 path is genuinely useful. Safe mode is off by default, advisories are warnings, and `accountType` is undefined until the Java sidecar is updated. So even in the sub-$25K case, the immediately-useful surface is small relative to ~107 lines of changes.

### Duplicate IBKR enforcement
The hard block on `dayTradesRemaining === 0` is **strictly redundant** with IBKR's server-side enforcement — IBKR will reject the order with error 201 "Order rejected - reason: Pattern Day Trader rule violation." The author's own comment admits this: *"IBKR will reject this order"*. The block saves one sidecar round-trip and produces a friendlier log message. That's a marginal benefit, not a safety mechanism.

### Counting model is wrong for ADD/scaling
`countDayTradesInWindow` counts CLOSED trade rows whose `openedAt` and `closedAt` ET-date match. The codebase models `OPEN`/`ADD`/`TRIM`/`CLOSE` against a single Trade row — so a position opened Monday, ADDed Tuesday, and CLOSED Tuesday will NOT count (openedAt is Monday). FINRA, however, considers each ADD-then-close-same-day as a day trade. **The counter undercounts in scaling scenarios.** This makes safe mode a fig leaf if the trader uses ADDs, which is a common pattern in this room.

Worse: there is no integration test of `countDayTradesInWindow` against real DB rows. The risk-check tests stub the dep. The window-start helper is tested but the SQL — which is the load-bearing logic — is not.

### Duplicated `broker.getAccountBalance()` calls
After this change, `checkRiskLimits` triggers `broker.getAccountBalance()` **3 times per call** (current equity, dayTradesRemaining, accountType) because the three new deps are independent thunks. Plus the pre-existing call in `calculatePositionSize`. That's 4 sidecar round-trips per `OPEN` signal where 1 would do. SimBroker has a balance cache; IBKR client does not. This is a real latency regression on every order.

### Architecture smell: deps explosion
Three new deps were added to `RiskCheckDeps` for one feature. They could have been one (`getPdtState(): Promise<{ remaining?: number; inWindow: number; accountType?: '...' }>`), keeping the surface area smaller and amortizing the broker call. Or, since all three originate from a single `AccountBalance` fetch, the risk-check could take an `AccountBalance` directly — but that would couple it to broker types.

### Pipeline rails: pass
No `if (isBacktest)` was added to `src/pipeline/` or `src/orders/`. The pre-existing `isBacktestScope` for reconciliation is untouched. Backtest disables PDT via `pdtSafeMode: false` and via `dayTradesRemaining` being undefined from SimBroker (which returns undefined for both new fields). 

### Test theatre
The `getPdtWindowStartKey` tests are real and walk holidays/weekends correctly (Good Friday 2026-04-03 verified in `et-date.ts`). The risk-check PDT tests stub the dep so they only validate plumbing — fine for that purpose. **Missing:** no test of the SQL date-coercion in `countDayTradesInWindow`, no test of overnight vs same-day exclusion, no DST-boundary test, no ADD/scaling test (which would expose the under-count bug). The author tested the easy half.

### `accountType` is dead code today
`accountType` is "wired" through schema, types, client, deps, and a warning path — but the Java sidecar doesn't return it. There's no `// TODO: update sidecar` and no PR reference. So a useful-looking advisory is permanently silent until somebody else does the Java work. Adding TS types ahead of the data source is ok if explicit, but here it's silently dead.

### Lessons file: missing
No `docs/lessons/2026-04-24-pdt-*.md`. CLAUDE.md mandates one after every implementation session. The four lesson files dated today are unrelated.

## Verdict: REWORK

This change is half-justified, half-implemented, and rings the wrong alarm. The IBKR-0-remaining hard block is duplicate enforcement of what IBKR does server-side. Safe mode is dormant by default and undercounts in the very-common ADD scenario, so even when enabled it's unreliable. The `accountType` advisory is plumbed end-to-end but the Java sidecar doesn't expose the field, so it's dead code shipped as live. And every order now does 3-4 sidecar round-trips for account balance where it used to do 1. The author got the holiday math right and respected the pipeline rails — but the actual day-trade counting (the SQL where mistakes matter) has zero integration test coverage and the data model is wrong for ADD/scaling. If the account is over $25K (the scenario for serious go-live capital), none of this code fires beyond no-op early-returns; it's pure bloat.

If the user is going live sub-$25K, they need this done correctly — not the current half-build.

## Required fixes
1. **Decide and document:** is the live account < $25K? If ≥ $25K, drop this worktree. If <, proceed with fixes below.
2. **Fix the day-trade counter to handle ADD:** count distinct same-day buy→sell pairs from `trade_messages`/`fills` history, not just CLOSED Trade rows whose `openedAt` matches `closedAt`. A trade with multiple intraday legs needs to be decomposed into round-trips.
3. **Cache `broker.getAccountBalance()` per risk-check invocation.** Either pass `AccountBalance` into `checkRiskLimits` once, or memoize for the duration of a single risk-check call. 4 round-trips per order is unacceptable.
4. **Either remove `accountType` plumbing, or update the Java sidecar (`AccountRoutes.java`) to include `"accountType", subData.getOrDefault("AccountType", "")` in the summary response.** Don't ship dead code.
5. **Add an integration test for `countDayTradesInWindow`** against seeded trade rows: same-day open/close included, overnight excluded, DST-boundary trade (Nov 1 2026 falls back) handled, multiple closes in window aggregated, and at least one ADD-then-same-day-CLOSE case (which should fail until #2 is fixed).
6. **Drop the `dayTradesRemaining === 0` hard block** unless you can demonstrate a friendlier-error case worth 30 lines of code; IBKR's reject is sufficient.
7. **Write the mandatory lesson file** `docs/lessons/2026-04-24-pdt-risk-check.md` with Problem/Decision/Key Files/Watch Out per CLAUDE.md.
8. **Verify the actual go-live scenario.** Run `/verify` against a paper account with `dayTradesRemaining` exposed; confirm the warn-vs-block paths fire as expected.

## Reviewer verdict

**REWORK** — confirming the thesis. Falsification attempts mostly failed; the core diagnoses hold.

### Agreements (verified)
- **Sidecar dead code:** `grep -rn "accountType\|AccountType" sidecar/src` returns zero hits. `AccountRoutes.java` does not expose `accountType`. The CASH advisory path (`risk-check.ts:206`) is permanently silent — confirmed.
- **3-4× balance round-trips per OPEN:** With `pdtSafeMode=false` (the shipped default), `checkRiskLimits` calls `getDayTradesRemaining` (line 85), `getCurrentEquity` (181), and `getAccountType` (205) — each an independent thunk; `build-deps.ts:166-176` wires each to `broker.getAccountBalance()`. IBKR `getAccountBalance` (`client.ts:450-479`) has no memoization. Plus the pre-existing call in `calculatePositionSize`. 4 sidecar round-trips per signal where 1 would do — real latency regression.
- **ADD-scaling undercount:** Schema confirms `openedAt`/`closedAt` are the original-OPEN and final-CLOSE timestamps on a single Trade row. `pdt.ts:49-50`'s SQL filter `opened_at::date = closed_at::date` excludes the OPEN-Mon / ADD-Tue / CLOSE-Tue case where the Tuesday ADD-close is a real day trade per FINRA. Safe mode undercounts in the common ADD pattern.
- **Counter SQL untested:** No integration test seeds DB rows; only the helper `getPdtWindowStartKey` and the stubbed risk-check branches are covered.
- **Lesson file missing:** `docs/lessons/` shows four 2026-04-24 files, none PDT.
- **Pipeline rails respected:** No `if (isBacktest)` introduced. SimBroker's undefined balance fields make the gates inert in backtest by data, not by branching.

### Disagreements / minor nits
- **Thesis fix #2** suggests counting from "`trade_messages`/`fills` history" — the schema doesn't expose a `fills` table; fills live as JSON in `brokerLegFills` on Trade rows. The fix is right in spirit (decompose intraday legs into round-trips) but the data source is `trade_events` + the JSON leg-fill array, not a fills table.
- **Hard-block redundancy** is slightly stronger than "marginal." A friendly preempt also avoids the order-status-error round trip and gives one log line; not nothing on a sub-$25K account, but the thesis is right that it's not a *safety* mechanism.

### Missed by thesis
- The duplicate-OPEN guard at `risk-check.ts:135` runs *after* the PDT hard block, so a `dayTradesRemaining=0` returned from a stale `getAccountBalance()` would block CLOSE...wait, `CLOSE`/`TRIM` short-circuit at line 68 before any PDT check, so closes are safe. Good.
- `pdtWarning` precedence: cash-account warning is unreachable today (sidecar) AND unreachable when `dayTradesRemaining<=1` triggers first — double-dead. Worth noting.
- `getPdtWindowStartKey` uses `PDT_WINDOW_DAYS - 1` iterations for an inclusive 5-day window. Math is right (verified by tests) but the constant naming is mildly confusing — `PDT_WINDOW_DAYS=5` but loop runs 4 times.

### Verdict
REWORK. Thesis stands. Sub-$25K is the only scenario where any of this fires; in that scenario the counter undercounts ADDs, the SQL has no integration test, the cash advisory is dead code, and every order pays a 4× balance-call penalty. Author got holiday/DST math right and respected pipeline rails — but the load-bearing day-trade SQL is the part that wasn't tested. Required fixes #2 (ADD handling), #3 (cache balance), #4 (sidecar or remove), #5 (integration tests) are mandatory before merge. If account is ≥ $25K, drop the worktree entirely.
