# Back Navigation via `?from=` Query Param

## Problem

Clicking a trade link from the backtest detail page (`/backtests/:id`) navigated to `/trades/:id`, but the back button hardcoded its target as `/trades` (or checked `from === 'tasks'`). The user landed on the wrong page when clicking back.

## Decision

Introduced a `?from=` query param pattern. Link sites encode `location.pathname` as `from` when navigating to cross-linked detail pages. The detail page reads `from` via a new `useBackHref(defaultPath)` hook that returns a channel-scoped back href, falling back to `defaultPath` when `from` is absent.

This is better than `navigate(-1)` (breaks in new tabs, unpredictable) and better than string enums like `from === 'tasks'` (doesn't scale, silently wrong when new link sources are added).

## Key Files

- `web/src/hooks/use-back-href.ts` — the hook
- `web/src/components/trade-row.tsx` — primary link site (shared across all trade tables)
- `web/src/views/trades/[id]/page.tsx` — trade detail back button (consumer)
- `docs/rails/back-navigation.md` — the rails doc for this pattern

## Watch Out

- Any new page that links to `/trades/:id` must pass `{ from: pathname }` in the href params, or the back button will fall back to `/trades`.
- The `from` value is validated to start with `/` to prevent open-redirect issues.
