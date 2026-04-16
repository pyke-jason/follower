# Back Navigation

Detail pages need a back button. The wrong approach is hardcoding a destination (`/trades`) or using `navigate(-1)` (breaks in new tabs, unpredictable after in-page navigation). The right approach is a `?from=` query param that encodes where the user came from.

## The pattern

**Link site** (any page linking to a detail page):

```tsx
import { useLocation } from 'react-router-dom';

const { pathname } = useLocation();
const href = useScopedHref();

<Link to={href(`/trades/${id}`, { from: pathname })}>
```

This produces `/trades/xxx?channel=bt:foo&from=/backtests/foo`.

**Detail page** (the page with the back button):

```tsx
import { useBackHref } from '@/hooks/use-back-href';

const backHref = useBackHref('/trades'); // fallback if no ?from=

<Link to={backHref}><ArrowLeft /></Link>
```

`useBackHref` reads `?from=`, validates it starts with `/`, and returns a channel-scoped href. If `from` is absent or invalid, it falls back to the provided default path.

## When to use

Use `?from=` on any entity that is reachable from multiple parent pages. Trades are the canonical example -- accessible from backtests, dashboard, tasks, reconciliation, traders, and messages.

Pages reachable from only one parent (e.g., `/backtests/:id` is only linked from `/backtests`) can hardcode the back target.

## Files

| File | Role |
|------|------|
| `hooks/use-back-href.ts` | The hook -- reads `?from=`, returns scoped href |
| `hooks/use-scoped-href.ts` | Builds hrefs with `?channel=` and extra params |
| `lib/channel-scope.ts` | Low-level path + query string builder |

## Rules

- Always pass `from: pathname` when linking to a cross-linked detail page.
- Never use `navigate(-1)` or `history.back()` for back buttons.
- Never use string enums for `from` (e.g., `from === 'tasks'`). Use the actual pathname.
- The `from` value must be a relative path starting with `/`. `useBackHref` rejects anything else.
