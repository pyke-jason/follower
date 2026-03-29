---
paths: web/src/components/**, web/src/views/**
---

# shadcn/ui — Component Selection Rules

This file governs **which UI component to reach for**. For page architecture, file decomposition, and data flow patterns, see `web-components.md`.

## Hard constraints

These are never acceptable. Violations must be fixed before the feature is considered done.

- **No raw HTML primitives.** Never `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>`, `<tr>`, `<td>`, `<th>`, `<kbd>`. Always use the shadcn equivalent from `web/src/components/ui/`.
- **Never use Sheet.** Use Dialog (focused inspection) or ResizablePanelGroup (persistent split pane). Sheet was removed from codebase patterns — `signal-sheet.tsx` uses Dialog despite its legacy name.
- **Never use `window.confirm()`.** Use AlertDialog from `@/components/ui/alert-dialog`.
- **Prefer Tooltip over native `title` attribute.** Exception: SVG elements or cells inside virtualized tables (5000+ rows) where mounting a Tooltip per-cell is prohibitive. In those cases `title` is acceptable with a `// PERF: title used for virtualized row` comment.

## Before building UI, check the cookbook

The cookbook at `web/docs/cookbook/` contains intent-driven decision guides. Read the relevant file before choosing a pattern:

| Intent | Cookbook file |
|---|---|
| Dangerous/irreversible action | `01-destructive-actions.md` |
| Form, validation, editing | `02-forms-data-entry.md` |
| Multi-step wizard | `03-multi-step-workflows.md` |
| Table (sort, filter, paginate) | `04-data-tables.md` |
| Search, autocomplete, multi-select | `05-search-and-selection.md` |
| Navigation, sidebar, breadcrumbs | `06-navigation.md` |
| Detail view (split pane, dialog, hover) | `07-detail-views.md` |
| Feedback (toast, loading, empty, badge) | `08-feedback-and-status.md` |
| Settings, toggles, preferences | `09-settings-and-preferences.md` |
| Layout (cards, accordion, resize) | `10-content-organization.md` |
| Row actions, context menu, toolbar | `11-context-menus-and-actions.md` |
| Keyboard shortcuts, focus, a11y | `12-keyboard-patterns.md` |
| Filter assembly (which component for which filter) | `13-filter-patterns.md` |
| Component nesting recipes (assembly diagrams) | `14-component-recipes.md` |

## Component selection — by intent

These are the component-picking decisions that come up most often. The goal is to eliminate guesswork, not to repeat the full shadcn guide (`docs/rails/shadcn.md` has the exhaustive table).

### Destructive actions
AlertDialog with count for bulk operations, type-to-confirm for catastrophic. Undo-via-toast for low-stakes single-item removal.

### Mutations
Always toast. `toast.success()` on success, `toast.error()` on failure. A silent mutation is a bug — the user has no feedback that their action landed.

### Empty states
Use `<EmptyState>` from `@/components/empty-state` with `variant` prop: `'default'` (first-run, icon + CTA), `'filtered'` (clear-filters button), `'error'` (destructive accent + retry). Never return `null` or render bare text for empty collections.

### Filters — pick by cardinality
| Cardinality | Component |
|---|---|
| 2-6 options, always visible | `ToggleGroup` |
| <15 options, single pick | `Select` |
| 15+ options or multi-select | `Popover` + `Command` + `Checkbox` (legacy) or `Combobox` (preferred for new code) |

`Combobox` (`@/components/ui/combobox`) is a newer shadcn primitive that handles searchable select and multi-select. Use it for new filter components. Existing code in `trade-filters.tsx` uses the `Command + Popover + Checkbox` pattern — do not rewrite working code just to migrate, but prefer `Combobox` when building new filters.

### Tooltips and keyboard hints
- `TooltipProvider` is mounted at the app root (`main.tsx`). Never add a local `TooltipProvider`.
- Use `Kbd` from `@/components/ui/kbd` for shortcut hints. Never raw `<kbd>` elements.

### Form fields
Use `Field`, `FieldLabel`, `FieldError` from `@/components/ui/field`. Group related fields with `FieldSet` + `FieldSeparator`. Validate on blur, show `FieldError` below the field.
