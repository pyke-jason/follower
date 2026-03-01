---
paths: web/app/components/**, web/app/**/page.tsx, web/components/ui/**
---

# Web Components & Pages

## Use Shared Utilities — Don't Duplicate

Before writing any helper function in a component or page file, check if it already exists:

| Need | Location | Examples |
|------|----------|---------|
| Formatting | `web/lib/format.ts` | `formatCurrency`, `formatDate`, `formatTime`, `formatDuration`, `pnlColor`, `isoToDateKey` |
| Class merging | `web/lib/utils.ts` | `cn()` (clsx + tailwind-merge) |
| Run scoping | `web/lib/run-scope.ts` | `buildHref()`, `isRunScopedPath()` |
| Author colors | `web/lib/author-colors.ts` | `getAuthorColor()` |
| DB queries | `web/lib/queries.ts` | 50+ query functions |
| DB types | `@db/schema` | `Trade`, `Message`, `TradeEvent`, etc. |
| DB accessors | `@db/accessors` | `getLegs()`, `getConfig()`, `getSummary()` |
| Backend utils | `../../../src/lib/numbers` | `roundCents`, `safeParseFloat` |
| Commission | `../../../src/lib/commission` | `computeTradeCommission()` |
| Stats | `../../../src/lib/core-stats` | `computeCoreStats()` |

**Known duplications to avoid repeating:**
- `relativeTime()` — exists in 3+ files. Use or extract to `web/lib/format.ts`.
- `TimelineMessage` type — defined in both `trades/actions.ts` and `decision-timeline.tsx`. Import from one place.

## Component Patterns

- **DO NOT MODIFY `web/components/ui/`**: These are shadcn/ui managed files. Never edit them directly. Use `npx shadcn@latest add <component>` to install new ones.
- **Styling**: Use Tailwind classes + `cn()` helper. No CSS modules, no styled-components.
- **UI primitives**: Use shadcn/ui from `@/components/ui/`. Don't build custom buttons, inputs, dialogs, etc.
- **Server vs Client**: Pages are async server components by default. Only add `'use client'` when you need interactivity (state, effects, event handlers).

## Data Flow

- **Read**: Server components call `web/lib/queries.ts` functions directly
- **Write**: Server actions (`'use server'`) in `actions.ts` files per route
- **Mutations**: Form actions preferred (progressive enhancement). Use `revalidatePath()` after writes.
- **Client data**: Pass from server component to client component via props. Avoid client-side fetches except for polling (`/api/status`).

## Backend Imports

Use path aliases from `tsconfig.json`:
- `@db/*` -> `../src/db/*` (schema, accessors)
- `@broker/*` -> `../src/broker/*` (types only)
- `@secrets` -> `../src/lib/secrets`

For other `src/` imports, use relative paths (`../../../src/lib/...`).
