---
paths: web/app/components/**, web/app/**/page.tsx, web/components/ui/**
---

# Web Components & Pages

## Use Shared Utilities — Don't Duplicate

Before writing any helper function in a component or page file, check if it already exists:

| Need | Location | Examples |
|------|----------|---------|
| Formatting | `web/lib/format.ts` | e.g. `formatCurrency`, `pnlColor`, `relativeTime`, `signalBorderColor` |
| Class merging | `web/lib/utils.ts` | `cn()` (clsx + tailwind-merge) |
| Run scoping | `web/lib/run-scope.ts` | `buildHref()`, `isRunScopedPath()` |
| Author colors | `web/lib/author-colors.ts` | `getAuthorBgColor()`, `getAuthorTextColor()`, `getAuthorInitials()` |
| DB queries | `web/lib/queries.ts` | All server-side data fetching (check before writing new queries) |
| DB types | `@src/db/schema` | `Trade`, `Message`, `TradeEvent`, etc. |
| DB accessors | `@src/db/accessors` | `getLegs()`, `getConfig()`, `getSummary()` |
| Backend utils | `@src/lib/numbers` | `roundCents`, `safeParseFloat` |
| Commission | `@src/lib/commission` | `computeTradeCommission()` |
| Stats | `@src/backtest/report` | `computeCoreStats()` |

**Previously fixed duplications** (do not re-introduce):
- `relativeTime()` — canonical location is `web/lib/format.ts`. Always import from there.
- `TimelineMessage` type — canonical location is `web/app/trades/actions.ts`. Always import from there.

## Component Patterns

- **DO NOT MODIFY `web/components/ui/`**: These are shadcn/ui managed files. Never edit them directly. Use `npx shadcn@latest add <component>` to install new ones.
- **Styling**: Use Tailwind classes + `cn()` helper. No CSS modules, no styled-components.
- **UI primitives**: Use shadcn/ui from `@/components/ui/`. Don't build custom buttons, inputs, dialogs, etc.
- **Server vs Client**: Pages are async server components by default. Only add `'use client'` when you need interactivity (state, effects, event handlers).

## Data Flow

- **Read**: Server components call `web/lib/queries.ts` functions directly
- **Write**: Server actions (`'use server'`) in `actions.ts` files per route
- **Mutations**: Form actions preferred (progressive enhancement). Use `revalidatePath()` after writes.
- **Client data**: Pass from server component to client component via props. Avoid client-side fetches except for polling/streaming (routes under `web/app/api/`).

## Backend Imports

Use path aliases from `web/tsconfig.json`:
- `@src/*` -> `../src/*` (all backend imports: schema, accessors, broker types, lib utilities)
- `@/*` -> `./*` (web-local files only)

Examples: `@src/db/schema`, `@src/db/accessors`, `@src/lib/numbers`, `@src/lib/secrets`, `@src/broker/ibkr`. Never use relative `../../../src/` paths.
