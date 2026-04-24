# web/ -- Frontend

Vite + React SPA. shadcn/ui for all primitives. Hono API proxied through Vite on `:3000` (backend on `:3791`).

## Directory layout

```
web/src/
  views/          # Page files, organized by route (e.g., views/trades/page.tsx)
  components/     # Shared app components (DataTable, EmptyState, etc.)
  components/ui/  # shadcn primitives -- DO NOT MODIFY (managed by shadcn CLI)
  hooks/          # Custom hooks (use-filter-params, use-api-mutation, etc.)
  stores/         # Zustand stores (channel, chat, trades -- cross-component state only)
  lib/            # Utilities (api.ts, format.ts, utils.ts, channel-scope.ts)
web/docs/cookbook/ # Intent-driven UI decision guides (read before building)
```

## Rules that load contextually

When editing frontend files, two rule files load automatically alongside this file:

- **`.claude/rules/shadcn-ui.md`** -- Which component to use for each intent. Hard constraints (no raw HTML, no Sheet, no confirm()). Cookbook index. Component selection patterns.
- **`.claude/rules/web-components.md`** -- How to structure pages and files. Size limits. Decomposition rules. Reuse-before-rebuild table. Data flow patterns. Shared utilities inventory.

Do not duplicate content from those files here. Read them for the full rules.
