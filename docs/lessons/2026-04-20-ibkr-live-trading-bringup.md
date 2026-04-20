# IBKR Paper-Live Bringup — Bugs & Issues Found

First session running the live IBKR pipeline against paper account `DUP246375`. Each entry lists what happened, root cause, and status.

---

## 1. `reqAccountUpdates` never called after connect (FIXED)

**Problem:** Every call to `/api/account/summary` returned HTTP 503 `"Account data not ready — subscription still initializing"`, even six minutes after gateway connect. `getAccountBalance` retried 5× with exp backoff, hit the circuit breaker, and failed every trade task that needed pre-trade sizing.

**Root cause:** `TwsBridge.managedAccounts()` guarded `reqAccountUpdates` with `if (connected && !accountSubscriptionActive)`. IBKR fires `managedAccounts` *before* `nextValidId` (which sets `connected=true`), so the guard failed on every connect. `accountDownloadEnd` never fired and `accountSubscriptionActive` stayed `false` forever. Zero `Started reqAccountUpdates subscription…` log lines in any prior run.

**Fix:** Moved the `reqAccountUpdates` call into `nextValidId`. `managedAccounts` now only captures the `accountId` field.

**Files:** `sidecar/src/main/java/com/tradefollower/sidecar/TwsBridge.java`

---

## 2. IBKR `Submitted` mapped to `PENDING` orphaned every live fill (FIXED)

**Problem:** Live orders placed at IBKR filled at the broker but never appeared in the local `trades` table. Two MSTR + SIRI positions sat at IBKR with no DB row, no orphan-fill alert, nothing.

**Root cause:** Two-bug cascade, masked by backtest parity gap:

1. `src/broker/ibkr/client.ts` `mapIbkrStatus` mapped IBKR `Submitted` / `PreSubmitted` → `'PENDING'`.
2. `src/pipeline/execute-resolved.ts:325` registered the pending intent only when `result.status === 'OPEN'` (`onPending` call). `PENDING` was skipped.
3. `src/orders/order-manager.ts:85` `tick()` loop: `if (order.status !== 'OPEN') continue;` — `PENDING` orders never got polled for state transitions.
4. Net: every live order was registered in `workingOrders` but ignored by the tick, and had no pending intent, so fills were never detected, never recorded, and never even surfaced as orphan-fill alerts.

`SimBroker` always returns `'OPEN'` so the backtest path was untouched by the bug — every test passed.

**Fix:** Mapped `Submitted` / `PreSubmitted` → `'OPEN'` at the IBKR client. Kept `Inactive` → `'PENDING'` (GTC outside RTH is correctly "queued, not actively working"). Single-point fix; the rest of the pipeline already handles `OPEN` correctly.

**Files:** `src/broker/ibkr/client.ts`

**Watch out:** If you ever need a true `PENDING` path (submitted-but-not-acknowledged), add it as a new state instead of re-overloading `PENDING`. `OPEN` and `PENDING` are semantically distinct in the enum; don't collapse them again.

---

## 3. Sidecar snapshot timeout was 5s; IBKR needs ~11s (FIXED)

**Problem:** Quote requests timed out before `tickSnapshotEnd` could fire.

**Root cause:** `TwsBridge.REQUEST_TIMEOUT_SECONDS = 5`. IBKR docs: `tickSnapshotEnd` fires approximately 11 seconds after the request — the 5s cap guaranteed false timeouts even on healthy snapshots.

**Fix:** Bumped to `15` seconds.

**Files:** `sidecar/src/main/java/com/tradefollower/sidecar/TwsBridge.java`

---

## 4. Subscription-error codes swallowed as "informational" (FIXED)

**Problem:** TWS errors `10089`/`10091`/`10167` (market data subscription required / delayed data active) were classified as informational-only, logged at debug level, and returned from the sidecar as HTTP 504 snapshot timeouts. Backend had no way to tell "no subscription" apart from a generic slow response.

**Fix:**
- Removed `10089/10091/10167` from `INFORMATIONAL_CODES` in `TwsBridge`.
- Added `TwsException.isNoMarketData()` covering `354/10089/10090/10091/10186/10197`.
- `App.java` returns HTTP **402** for these.
- `src/broker/ibkr/client.ts` classifies HTTP **402** and **504** as `permanent` (no retry on a missing-subscription or silent-drop).
- `getQuote` catches the 402 and fires `sendSystemAlert({ severity: 'critical' })` once per symbol (module-level dedup `Set`) — Discord + Pushover.

**Files:** `sidecar/.../TwsBridge.java`, `TwsException.java`, `App.java`, `src/broker/ibkr/client.ts`

---

## 5. Competing live-account session blocks paper market data (DOCUMENTED)

**Problem:** TWS error `10197 "No market data during competing live session"` blocked every quote. Even after activating streaming subscriptions, quotes silently dropped.

**Root cause:** IBKR allows exactly one active market-data session per subscription. If the live user (`pykeswims`) is signed in anywhere else (Mobile app, Client Portal, desktop TWS, another API process), the paper user sharing that subscription gets `10197`. Not a bug in our code — a hard IBKR constraint.

**Fix:** Kill every other live-account session (see `docs/ibkr/connection.md` if we add a section there). No code change was required; the alert from issue #4 now surfaces the problem explicitly.

**Watch out:** IBKR Mobile's background session is the most common culprit and not visible in `ps`. Force-signout from the phone, not just background the app.

---

## 6. MANUAL_REVIEW overused for deterministic cases (PROPOSED — NOT YET FIXED)

**Problem:** Most exit signals on symbols we don't hold (`Exit Long RBRK/UAL/RKLB/JPM/BSX/ON`) route to `MANUAL_REVIEW` with reason `"no open position found for X"`. That's a deterministic outcome, not an ambiguity that needs human review. The Tasks page fills with "review this" items that are actually clean skips.

**Current behavior:** `src/intents/orchestrator/position-path.ts` returns `MANUAL_REVIEW` for every branch that can't find a matching position, including:
- No parsed symbol
- Invalid action
- `getPositions` failed (transient broker error)
- No open position found
- TRIM without exit %
- LEG_OFF without `targetStrategy`

**Proposed fix:** Reserve `MANUAL_REVIEW` for genuinely ambiguous matcher outcomes (`flagReason` from `matchPosition`, mixed signals, contradictory legs). Reclassify the deterministic branches as `SKIP` with specific `skipCategory` values:
- `no_open_position` (what fires most)
- `parse_missing_symbol`
- `broker_error` (transient; let retry/poll handle it)
- `trim_missing_percent`
- `legoff_missing_target_strategy`

Keep LLM ambiguity paths (`"LLM did not call a decision tool"`) as `MANUAL_REVIEW` — those *are* genuinely ambiguous.

**Files:** `src/intents/orchestrator/position-path.ts`

---

## 7. ASTS PCS combo rejected by TWS as "riskless" (OPEN)

**Problem:** Michael_L signal `Sold PCS 72/69 May for $0.70` routed through the combo path and was rejected by TWS: `201: Order rejected - reason:Riskless combination orders are not allowed.` — on a legitimate 3-wide put credit spread that is demonstrably not riskless (max loss $2.35, max gain $0.65).

**Hypothesis:** The combo legs were built with reversed actions (`BUY` the near-strike put and `SELL` the far-strike put instead of the other way round), making TWS's arbitrage check fire. A correctly constructed PCS is sell-high-strike-put + buy-low-strike-put.

**Status:** Not yet investigated. Reproduce by triggering another ASTS PCS signal or by building the combo body manually and posting to `/api/orders/combo`.

**Files to check:** `src/intents/orchestrator/open-path.ts`, spread-leg builder (wherever PCS/CCS legs are constructed), `src/pipeline/execute-resolved.ts` combo path.

---

## 8. Position sizer ignores trader's signaled contract count (OPEN — DESIGN Q)

**Problem:** Michael_L signal `PCS 72/69 May (1)` → position sizer produced `qty=213` contracts (before the combo was rejected). Risk budget + 3-wide spread × $2.35 max loss → ~$50K notional risk → 213 contracts.

This is intentional for stocks (copy the signal's direction, size to our own risk budget) but is more jarring for options, especially spreads with defined risk that a trader might be sizing-by-contract on purpose.

**Status:** Not strictly a bug — this is the sizer working as designed. Flagging because a trader saying "(1) contract" probably means they have a specific exposure in mind and scaling to $50K notional is not a faithful copy. Worth a product discussion.

**Files:** wherever `calculatePositionSize` lives for option spreads.

---

## 9. Benign `300 "Can't find EId"` log spam (OPEN — COSMETIC)

**Problem:** Every successful snapshot is followed by `TWS error [id=N]: 300 - Can't find EId with tickerId:N` in the sidecar log. Looks scary, means nothing.

**Root cause:** `TwsBridge.tickSnapshotEnd` calls `client.cancelMktData(reqId)` defensively after the snapshot completes. Snapshots auto-clean up on the TWS side, so the explicit cancel hits an already-torn-down subscription → TWS replies with error 300.

**Fix:** Delete the `client.cancelMktData(reqId)` line in `tickSnapshotEnd`. Low priority; purely log hygiene.

**Files:** `sidecar/src/main/java/com/tradefollower/sidecar/TwsBridge.java`

---

## 10. Task detail page UX was illegible (FIXED)

**Problem:** On `tasks/[id]`, a row of equal-weight Cards (`Assignee/Priority/Created/Completed` → `Decision` → `Error`) left the user with no visual hierarchy. Chat context was a tall `h-80` scroller dominating the sidebar; parsed context was hidden behind an Accordion. Failures showed as bare error strings with no context of *what the orchestrator was doing* when they fired. `MANUAL_REVIEW` showed as one badge with no reason.

**Fix (sub-agent rework):**
- Outcome hero at the top (badge + symbol + direction + duration + one-line reason/error).
- `DecisionTimeline` as primary content: `parsed → routed → outcome → error-as-final-red-step`.
- Right rail inverted: `ParsedContext` always-expanded on top (Accordion removed, trades importer updated in same diff), `ChatPreview` below with `h-48` scoped to ~3 messages around the focus id.
- Card chrome dropped; sections use eyebrow `<h4>` labels, only the timeline is still wrapped in a Card.
- Errors rendered as the final red `Alert` step of the timeline, not a sibling Card.

**Files:** `web/src/views/tasks/[id]/page.tsx` (rewritten), `web/src/views/trades/[id]/parsed-context.tsx` (Accordion + Card wrapper dropped — trades importer updated in the same diff), new siblings `outcome.ts`, `outcome-hero.tsx`, `decision-timeline.tsx`, `task-details.tsx`.

**Deviation from spec:** `UnifiedTimeline`/`ExecutionTrace` on the trades page are tightly bound to `useTradesStore.story`. Factoring them out would have touched the trades page beyond this work's scope, so the task page has its own lean timeline using the same dot+rail visual language. Can consolidate later if we decide to invest the refactor.

---

## Appendix — End-to-end proof

After issues #1, #2, #3, #4 shipped, eight live-channel trades tracked end-to-end in one market session:

| Trader        | Symbol  | Dir   | Qty   | Fill      |
|---------------|---------|-------|-------|-----------|
| (backfilled)  | MSTR    | LONG  | 296   | $169.19   |
| (backfilled)  | SIRI    | LONG  | 1866  | $26.90    |
| Cloud         | ONDS    | LONG  | 4645  | $10.81    |
| KaibabCowboy  | ONDS    | LONG  | 4645  | $10.81    |
| Cloud         | LWLG    | LONG  | 3529  | $14.25    |
| BlazingRogue  | SERV    | LONG  | 5050  | $9.95     |
| Tobias        | NVDA    | LONG  | 250   | $200.82   |
| Tobias        | CZR     | LONG  | 1801  | $27.89    |
| dav_9         | HIMS    | LONG  | 1590  | $31.58    |
| Chilled Chilly| MSTR    | LONG  | 297   | $168.63   |

Each produced the `[OrderMgr] Fill:` log entry and a populated `trades` row with broker fill metadata via the `onFill → recordFill → enrichTradeWithFill` path.
