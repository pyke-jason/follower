---
paths: web/app/components/**, web/app/**/page.tsx, web/components/ui/**, web/stores/**, web/lib/**
---

# Web Components & Pages

## Shared Utilities — Don't Duplicate

| Need | Location | Examples |
|------|----------|---------|
| Formatting | `web/lib/format.ts` | `formatCurrency`, `pnlColor`, `relativeTime`, `signalBorderColor` |
| Class merging | `web/lib/utils.ts` | `cn()` (clsx + tailwind-merge) |
| Channel scoping | `web/lib/channel-scope.ts` | `buildHref()`, `buildScopedPath()`, `buildScopedSearch()` |
| Author colors | `web/lib/author-colors.ts` | `getAuthorBgColor()`, `getAuthorTextColor()`, `getAuthorInitials()` |
| API client | `web/lib/api.ts` | `api<T>(path, init?)` — all HTTP calls go through this |

## Component Patterns

- **DO NOT MODIFY `web/components/ui/`**: shadcn/ui managed. Use `npx shadcn@latest add <component>` to install new ones.
- **Styling**: Tailwind classes + `cn()`. No CSS modules, no styled-components.
- **UI primitives**: Use shadcn/ui from `@/components/ui/`.
- **Vite SPA**: No server components, no `'use client'` directive. Everything is client-side.

## Data Flow

- **Read**: `useQuery` (TanStack Query) calling `api<T>('/path')`. The `api()` helper prepends `/web`.
- **Stores**: Zustand stores (`web/stores/`) for cross-component state. Hydrated from API responses.
- **Mutations**: `useMutation` calling `api('/path', { method: 'POST', body })`. Invalidate queries on success.
- **Routing**: React Router v6 (`web/app/router.tsx`). Channel scope via `?channel=` param, read with `useChannelId()`.
- **Type `useQuery` and `api()` calls**: Always `useQuery<ResponseType>` and `api<ResponseType>()` matching the actual API shape. No `useQuery<any>`. See API IS THE CONTRACT in CLAUDE.md.
