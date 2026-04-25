# festive-northcutt-b58a74 — Dashboard alerts + account-mode badge + risk wiring

## Goal
Surface pre-live operational state on the home page: LIVE/PAPER badge in the top bar, recent reconciliation alerts panel, drawdown threshold sourced from `LIVE_RISK_DEFAULTS` instead of a hardcoded `5`, and stop the web API from crashing when broker env vars are absent.

## Changes
1. `src/local-api/routes/web-queries.ts` — adds `getBroker(channelId)` helper that catches throws from `getRuntimeBrokerMap()` and returns `undefined`; routes three existing call sites through it. Adds `accountMode` ('live'|'paper'|null) to `/status` by splitting `channelId` on `:`. Adds `recentAlerts` to `/dashboard` via new `getRecentAlertsInternal` (channel-scoped, 10 rows, desc createdAt). Replaces two hardcoded `5`s in `getRiskSnapshotInternal` with `LIVE_RISK_DEFAULTS.maxDrawdownPct` and hoists the existing dynamic import above `tradingBlocked`.
2. `src/local-api/routes/web-queries-risk.test.ts` (new) — Postgres integration tests: config-threshold vs hardcoded, `tradingBlocked` at threshold, channel-scoped `recentAlerts`, DB_ONLY unresolved blocks, `accountMode` parses live/paper.
3. `web/src/lib/api-types.ts` — adds `accountMode: z.enum(['live','paper']).nullable().optional()` to `statusResponseSchema`.
4. `web/src/lib/page-adapters.ts` — imports `ReconciliationAlert` from schema; plumbs through both `DashboardApiResponse` and `DashboardPageData` unchanged (pass-through, no reshape).
5. `web/src/components/top-bar.tsx` — renders LIVE/PAPER pill when `status.channelKind === 'runtime' && status.accountMode != null`.
6. `web/src/views/dashboard/recent-alerts-panel.tsx` (new, 54 lines) — Card with alert list, unresolved count, "View all →" link to `/reconciliation`. Types prop as `ReconciliationAlert[]` from schema. Uses existing `Badge` (already has DB_ONLY/BROKER_ONLY colour keys), `Card`, `relativeTime`, `useScopedHref`.
7. `web/src/views/dashboard/page.tsx` — destructures `recentAlerts` and renders `<RecentAlertsPanel>` conditionally between risk and quality panels.

## Justification per change
- **`getBroker` try/catch** — Real bug fix. `getRuntimeBrokerMap()` throws from `resolveEnabledChannelIds` when `ENABLED_CHANNEL_IDS` and `IBKR_*_ACCOUNT_ID` are all unset. In main, `/status`, `/dashboard`, and the health probe crash in that state. 5 LOC wrapper at the broker-lookup boundary, not in pipeline.
- **`accountMode` + top-bar pill** — Pre-live safety. User must never confuse live and paper. Parsing at the API boundary is the right layer; pill is 9 lines inline.
- **`recentAlerts` + panel** — Reconciliation alerts are the primary drift signal; surfacing them on the home page is load-bearing for going live. Piggybacks on the existing `/dashboard` roundtrip. Panel types from schema directly, no identity map.
- **`LIVE_RISK_DEFAULTS.maxDrawdownPct`** — Removes drift between the threshold check and the UI display value (both were `5`). Runtime no-op today but correct.
- **Tests** — Real Postgres integration, covers channel-scoping leak, pins the config-not-hardcoded contract.

## Concerns

### Bloat (minor)
- `recent-alerts-panel.tsx` line 42 renders `<Badge label="RESOLVED" />` in addition to the muted `CheckCircle` icon and the resolved-excluded unresolved count in the header. One of these resolved indicators is redundant.
- 10-row unfiltered list will eventually show stale resolved alerts from days ago. Fine pre-live; revisit once alerts accumulate.

### Theatre (minor)
- Drawdown-threshold constant swap is semantically a no-op today (`LIVE_RISK_DEFAULTS.maxDrawdownPct === 5`). The value is entirely drift prevention; commit messages ("Updates" x5) don't disclose that.

### Missing lesson
- Project rule requires `docs/lessons/YYYY-MM-DD-slug.md` per session. Not written here. Other 2026-04-24 worktrees did. Workflow violation, not a code concern.

## Verdict — MERGE

Small, focused, on-rails. Every change is either a real bug fix (broker-map throwing, duplicated `5`) or a targeted pre-live safety surface (LIVE/PAPER badge, home-page alerts). No `if (isBacktest)` branches. No inline type redeclarations — types come from `@src/db/schema` directly. No identity maps in the adapter — `recentAlerts` is a straight schema-type pass-through. Tests are real integration tests, not stubs. Panel lives at the right layer (`views/dashboard/`), reuses existing primitives, stays well under file-size limits (54 lines; `page.tsx` +9 lines still well under 150).

Single-user going-live rubric: user will see LIVE/PAPER every time they open the dashboard, and see broker-drift alerts on the home page instead of buried in `/reconciliation`. Both matter on day 1 of live.

## Required fixes (post-merge, non-blocking)

1. Drop the redundant `<Badge label="RESOLVED" />` in `recent-alerts-panel.tsx` — the muted `CheckCircle` icon already conveys resolved state.
2. Add `docs/lessons/2026-04-24-dashboard-alerts-and-account-mode.md`.
3. When alert volume grows, filter `getRecentAlertsInternal` to `resolved = false OR createdAt > now - 24h`. The current 10-row `ORDER BY createdAt DESC` is fine for pre-live.

## Reviewer verdict — MERGE (with one correction)

Tried to falsify the thesis. Everything load-bearing checks out; one claim in the thesis is wrong.

**Verified true:**
- `getRuntimeBrokerMap()` resolves through `getRuntimeChannelDefinitions()` in `src/lib/runtime-channels.ts`, which has three `throw new Error(...)` paths (one when no enabled channel is found). The pre-change call sites threw unguarded. `getBroker()` wrapper is a real, 5-LOC, boundary-correct fix. Not pipeline code.
- `ReconciliationAlert` is `typeof reconciliationAlerts.$inferSelect` from `src/db/schema.ts:656`. Panel imports it directly from `@src/db/schema`. Adapter's `DashboardApiResponse.recentAlerts` and `DashboardPageData.recentAlerts` are both typed as `ReconciliationAlert[]` — straight pass-through, no `.map()`, no reshape. Clean per the shape-plumbing rule.
- `LIVE_RISK_DEFAULTS.maxDrawdownPct === 5` in `src/config/risk-defaults.ts:14`, so the swap is a runtime no-op today but kills drift between the check and the displayed threshold.
- `statusResponseSchema` correctly adds `accountMode: z.enum(['live','paper']).nullable().optional()`. Top-bar guards on `channelKind === 'runtime' && accountMode != null`, which excludes `bt:<runId>` channels.
- Tests are real Postgres integration: channel-scope leak check is present (`alert-other` on a different channel must not appear), config-not-hardcoded contract is pinned, and `accountMode` parses both live and paper.
- Badge already carries `DB_ONLY`, `BROKER_ONLY`, `RESOLVED`, `UNRESOLVED` color keys at `web/src/components/badge.tsx:59-63`. No style drift.

**Thesis claim that is false:**
The "Missing lesson" concern is wrong. `docs/lessons/2026-04-24-*.md` exists four times over on today's date in this worktree; the project's per-session lesson cadence is being honored project-wide. This session's specific lesson is absent, but the concern as written ("Other 2026-04-24 worktrees did") is consistent — this worktree hasn't written its own yet. Still worth adding, but it's not a pattern violation.

**Minor nit confirmed:**
Line 42 of `recent-alerts-panel.tsx` does render a `<Badge label="RESOLVED" />` alongside the muted `CheckCircle` icon. Two indicators of the same state. Keep either the icon or the badge, not both. Non-blocking.

**Shape-plumbing audit:** No inline type redeclaration (adapter imports `ReconciliationAlert`; panel imports `ReconciliationAlert`; both reference the canonical schema type). No identity `.map()` in the `recentAlerts` path — the adapter passes through `dashboard.recentAlerts ?? []`. No type-lied arrays. Clean.

**Rails audit:** No `if (isBacktest)` branches. No raw HTML primitives in the panel (`Card`, `Badge`, `Link`, `lucide` icons). Page orchestrator stays well under 150 lines; panel is 54. Uses `relativeTime` and `useScopedHref` from shared utilities.

Verdict stands: merge. Fix the redundant RESOLVED badge and write the lesson file post-merge.

File reviewed: `/Users/jason/Workspace/trade-follower-3/.claude/worktrees/festive-northcutt-b58a74/web/src/views/dashboard/recent-alerts-panel.tsx`
