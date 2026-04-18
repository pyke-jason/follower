---
paths: web/src/**
---

# shadcn/ui Best Practices

How to use shadcn/ui correctly in a React 19 + Vite + Tailwind v4 codebase. Every primitive lives in `components/ui/*` and is yours to edit. The CLI is the only distribution channel. The rest of this file answers "which primitive" and "how to compose."

## If you need X, use Y

| If you need... | Use this |
|---|---|
| A clickable action | `<Button>` |
| A link styled as a button | `<Button asChild><Link /></Button>` |
| A text input | `<Input>` (inside `<FormControl>` in a form) |
| A password field | `<Input type="password">` |
| A one-time-code input | `<InputOTP>` |
| A labeled validated input | `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl><Input/></FormControl>` + `<FormMessage>` |
| A single select | `<Select>` |
| A searchable select | `<Popover>` + `<Command>` (Combobox composition) |
| A multi-select | `<Popover>` + `<Command>` with checked items |
| A date picker | `<Popover>` + `<Calendar>` (single or range) |
| A command palette (Cmd+K) | `<CommandDialog>` |
| A confirmation ("Are you sure?") | `<AlertDialog>` |
| A form dialog or general modal | `<Dialog>` |
| A side panel (nav, filters, details) | `<Sheet>` |
| A mobile bottom sheet | `<Drawer>` (Vaul) |
| A hover tooltip (keyboard-focusable) | `<Tooltip>` |
| A richer hover surface | `<HoverCard>` |
| A popover anchored to a trigger | `<Popover>` |
| A right-click / long-press menu | `<ContextMenu>` |
| An action menu from a button | `<DropdownMenu>` |
| A nav bar with dropdowns | `<NavigationMenu>` |
| A toast notification | `toast()` from `sonner` |
| A page-level warning or info banner | `<Alert>` + `<AlertTitle>` + `<AlertDescription>` |
| An app shell / sidebar layout | `<SidebarProvider>` + `<Sidebar>` family |
| A breadcrumb trail | `<Breadcrumb>` |
| Tabs | `<Tabs>` |
| An accordion or FAQ | `<Accordion>` |
| A collapsible details block | `<Collapsible>` |
| A sortable / filterable / paginated table | `<Table>` + TanStack Table |
| A read-only static table | `<Table>` bare |
| A line / bar / area / pie chart | `<ChartContainer>` + Recharts |
| A loading placeholder for a known shape | `<Skeleton>` |
| Indeterminate activity | `<Spinner>` |
| Progress with known value | `<Progress>` |
| A status chip / tag | `<Badge>` |
| A user avatar | `<Avatar>` + `<AvatarImage>` + `<AvatarFallback>` |
| Pagination controls | `<Pagination>` |
| Resizable split panels | `<ResizablePanelGroup>` + `<ResizablePanel>` + `<ResizableHandle>` |
| A custom scroll region | `<ScrollArea>` |
| An on/off toggle (persisted) | `<Switch>` |
| A tool-state toggle | `<Toggle>` |
| A checkbox | `<Checkbox>` |
| A radio group | `<RadioGroup>` + `<RadioGroupItem>` |
| A slider / range | `<Slider>` |
| A keyboard-shortcut hint | `<Kbd>` |
| An empty-state block | `<Empty>` |
| A media ratio container | `<AspectRatio>` |
| Class merging in JSX | `cn()` from `@/lib/utils` |
| Component variant definitions | `cva()` from `class-variance-authority` |
| An icon | `lucide-react` with `className="size-4"` |
| A confirmation that `window.confirm()` would have handled | `<AlertDialog>` |
| A notification that `window.alert()` would have handled | `toast.error()` / `toast.success()` from sonner |
| A prompt that `window.prompt()` would have handled | `<Dialog>` with a single-field `<Form>` |

## Open Code: primitives are your code

shadcn/ui's core philosophy is Open Code: the top layer (`components/ui/*`) is meant for direct modification. There is no wrapper or override ceremony.

Rules that follow from this:

- Every file in `components/ui/` is first-party code. Edit the source, do not write wrappers around it.
- Do not install a component via `npm install` when it exists in the official registry. Use `npx shadcn@latest add <name>`.
- Before building any common UI surface from scratch, run `npx shadcn@latest search` or consult the component index. There are 70+ official components covering nearly every standard pattern — sidebar, data-table, chart, calendar, command, combobox, OTP input, and more.
- Prefer editing the generated primitive file over writing a wrapper for small changes (class tweaks, a new variant, a default prop). Wrappers that only pass props through add exactly the abstraction layer shadcn was designed to remove.
- Write a thin wrapper only when you are adding *behavior* — loading state, confirmation flow, form-field binding — not when you are adding styles. Behavior belongs above the primitive; style belongs inside it.
- Track primitives you have edited in a short `docs/shadcn-deviations.md` log. The CLI can overwrite files on re-add; a deviation log makes upstream sync a conscious action.

## Consistency: one primitive per concept

There must be exactly one component per UI concept. Two `Dialog` files — one wrapping Radix directly and one from shadcn — is the single worst consistency failure. Delete the bespoke one.

### No direct Radix imports in feature code

Never import from `@radix-ui/*`, `cmdk`, or `vaul` directly outside `components/ui/*`. Those primitives flow through shadcn wrappers that add accessible defaults, `data-slot` attributes, variants, and theme tokens.

```tsx
// Bad
import * as Dialog from '@radix-ui/react-dialog';

// Good
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
```

### No raw HTML primitives

Never render a bare `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>`, `<kbd>`, or `<a>` styled as a link-button when a shadcn equivalent exists. Raw elements skip focus rings, disabled states, theme tokens, and screen-reader behavior the primitives provide.

### No window.alert / confirm / prompt

These block the event loop, bypass your theme, ignore focus management, and look like a browser bug next to a modern UI.

| Replace | With |
|---|---|
| `window.alert(msg)` | `toast.error(msg)` or `toast.success(msg)` |
| `window.confirm(msg)` | `<AlertDialog>` |
| `window.prompt(msg)` | `<Dialog>` with a single-field `<Form>` |

### Sonner is the only toast surface

Use `sonner` (imported as `toast` from `sonner`) for all toasts. The legacy `Toast` primitive is deprecated — the old `useToast` hook and `<Toaster>` from `@/components/ui/toast` should no longer exist. Mount one `<Toaster />` in your app root.

```tsx
import { toast } from 'sonner';

toast.success('Saved');
toast.error('Something went wrong');
toast.promise(saveChanges(), {
  loading: 'Saving...',
  success: 'Saved',
  error: 'Failed to save',
});
```

### AlertDialog for destructive, Dialog for everything else

Use `<AlertDialog>` for any destructive or irreversible confirmation. Use `<Dialog>` for everything else. AlertDialog traps focus more aggressively, uses assertive ARIA, and signals the semantic difference between "are you sure?" and "here is a form."

### Sheet, Drawer, Dialog have distinct roles

- `<Sheet>` — off-canvas panels (nav, filters, details drawer).
- `<Drawer>` — mobile bottom sheets, built on Vaul.
- `<Dialog>` — centered modal overlays.

Never improvise one from the other. Each has different gestures, focus rules, and responsive behavior.

### CommandDialog for Cmd+K

Any palette, global search, or keyboard-first picker uses `<CommandDialog>`. It wires cmdk keyboard semantics (arrow keys, filter, groups) and focus-trap correctly. A hand-rolled `<Dialog>` + list does not.

### Combobox, DatePicker, MultiSelect are compositions

Do not install a third-party combobox or date picker. shadcn ships *recipes*, not monolithic components:

- Combobox = `<Popover>` + `<Command>`.
- DatePicker = `<Popover>` + `<Calendar>`.
- MultiSelect = `<Popover>` + `<Command>` with checked items.

The composition covers every real variant. Writing a bespoke combobox is the most common custom reinvention in shadcn codebases.

## Canonical forms pattern

Every form uses `<Form>` + `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl>` + `<FormDescription>` + `<FormMessage>` wired with React Hook Form and `zodResolver`. This is the single documented form pattern; it provides `aria-describedby`, `aria-invalid`, and error plumbing automatically.

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const schema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});
type Values = z.infer<typeof schema>;

function ProfileForm({ onSubmit }: { onSubmit: (v: Values) => void }) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', name: '' },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" {...field} />
              </FormControl>
              <FormDescription>We never share this.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Save
        </Button>
      </form>
    </Form>
  );
}
```

### Resolver and Zod versions

Use `@hookform/resolvers` v5.0.1 or later with `zodResolver`. When on Zod v4, import the schema from `zod` and the resolver from `@hookform/resolvers/zod` — do not downgrade. Older resolver versions throw on Zod v4's new `_zod.version` shape.

### Never mirror form fields into useState or a store

RHF owns form state. Mirroring fields defeats the uncontrolled-input performance that is the library's reason to exist. Read values via `form.watch(name)` when you must react mid-typing.

## asChild and Slot

Use `asChild` on `<Button>`, triggers, and menu items when the child is already a semantic element (`<Link>`, `<a>`), rather than nesting `<Button><Link/></Button>`. Nesting produces invalid HTML; `asChild` merges props onto a single element.

```tsx
<Button asChild>
  <Link to="/settings">Settings</Link>
</Button>
```

### Rules for children under asChild

- The child must accept and spread all props. Missing spread breaks classes, data-state, ARIA, and event handlers.
- The child must forward `ref` (in React 19, accept `ref` as a regular prop).
- If the child's `onClick` calls `event.preventDefault()`, the slot's handler is skipped. If both must fire, neither should cancel.

### data-slot for custom primitives

When you build a custom primitive, put a `data-slot="<name>"` attribute on each structural element and target it from CSS rather than wrapping with an extra `<div>`. `data-slot` is the convention shadcn adopted for Tailwind v4 and enables selectors like `group-data-[state=open]:*` to target specific parts of a primitive cleanly.

```tsx
function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('rounded-lg border', className)} {...props} />;
}
```

## cn, cva, and className ordering

### Merge classes with cn, never concatenate

`cn()` lives in `@/lib/utils` and wraps `clsx` + `tailwind-merge`. `tailwind-merge` resolves conflicts like `p-2 p-4` deterministically; string concatenation does not.

```tsx
// Bad
<div className={`p-2 ${isActive ? 'bg-primary' : ''} ${className}`} />

// Good
<div className={cn('p-2', isActive && 'bg-primary', className)} />
```

### Define variants with cva, in the primitive's file

```tsx
import { cva, type VariantProps } from 'class-variance-authority';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 px-3',
        lg: 'h-11 px-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
```

Do not maintain a parallel `variants.ts` map or duplicate a primitive's variants in a wrapper. One `cva` per primitive, in the primitive's file.

### Caller className wins

When a caller passes `className`, merge it last inside `cn()` so callers always win conflicts.

```tsx
// Inside the primitive
<div className={cn(buttonVariants({ variant }), className)} />
```

### Never reach for !important

`!important` to override a primitive signals that the primitive lacks the variant you need. Add the variant to the primitive's `cva`, or edit the primitive.

### Style via semantic tokens, not hard-coded colors

Use `bg-primary`, `text-foreground`, `border-input`, `ring-ring`, `bg-muted`, `text-muted-foreground`. Never hard-code `bg-blue-500`, `text-gray-900`, or `#111827` — hard-coded colors bypass dark mode and theming.

```tsx
// Bad
<button className="bg-blue-500 text-white">Save</button>

// Good
<Button>Save</Button>
```

## Tailwind v4 integration

### Tokens in :root + .dark, exposed via @theme inline

Declare design tokens in `:root` and `.dark`, then re-expose them to Tailwind via `@theme inline` in `src/index.css`. The `inline` form avoids the historical `hsl(var(--x))` wrapper.

```css
@import 'tailwindcss';

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.15 0 0);
  --primary: oklch(0.55 0.2 260);
  --primary-foreground: oklch(0.98 0 0);
  --border: oklch(0.92 0 0);
  --radius: 0.5rem;
}

.dark {
  --background: oklch(0.15 0 0);
  --foreground: oklch(0.98 0 0);
  --primary: oklch(0.65 0.2 260);
  --primary-foreground: oklch(0.1 0 0);
  --border: oklch(0.25 0 0);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-border: var(--border);
  --radius-sm: calc(var(--radius) - 2px);
  --radius-md: var(--radius);
  --radius-lg: calc(var(--radius) + 2px);
}
```

### Author colors in OKLCH

The v4 default palette is OKLCH for wider gamut and predictable lightness. Mixing OKLCH and HSL tokens produces visible seams at adjacent color stops. New color tokens go in OKLCH.

### Register custom utilities with @utility

Define reusable class patterns with `@utility`, not `@layer components`. `@utility` is the v4-sanctioned way to register custom utilities; it stays compatible with variants and `tailwind-merge`.

```css
@utility center-grid {
  display: grid;
  place-items: center;
}
```

### Prefer data-state selectors over JS class toggling

Radix primitives expose `data-state="open"`, `data-state="closed"`, `data-orientation="horizontal"`, etc. Drive styles from these attributes rather than toggling classes imperatively.

```tsx
<DialogContent className="data-[state=open]:animate-in data-[state=closed]:animate-out" />
```

For targeting parent state from a child, use `group-data-*`:

```tsx
<Accordion>
  <AccordionItem>
    <AccordionTrigger className="group">
      <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
    </AccordionTrigger>
  </AccordionItem>
</Accordion>
```

### Prefer size-* over w-* h-*

For square elements, `size-4` beats `w-4 h-4`. Fewer classes, less room for drift.

### Do not import tailwind.config.ts in v4

Tailwind v4 reads config from CSS. Do not import or reference `theme.extend` color objects from a `tailwind.config.ts` file.

## Icons with lucide-react

`lucide-react` is the only icon library. Size with a Tailwind class, never the `size` prop.

```tsx
import { CheckIcon } from 'lucide-react';

<CheckIcon className="size-4" />
<CheckIcon className="size-5 text-primary" />
```

### Accessibility

- Leave icons `aria-hidden` (Lucide's default) when they sit next to a text label. The label is the accessible name.
- For icon-only buttons, put `aria-label` on the `<Button>` and keep the icon `aria-hidden`.

```tsx
<Button size="icon" aria-label="Delete">
  <TrashIcon className="size-4" aria-hidden />
</Button>
```

## Data tables with TanStack Table

Build sortable, filterable, paginated tables with TanStack Table on top of the shadcn `<Table>` primitive, following the official `columns.tsx` / `data-table.tsx` / `page.tsx` split. Do not write a custom table renderer.

```tsx
// columns.tsx
import { ColumnDef } from '@tanstack/react-table';

export type User = { id: string; name: string; email: string };

export const columns: ColumnDef<User>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'email', header: 'Email' },
];
```

```tsx
// data-table.tsx
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
}

export function DataTable<TData, TValue>({ columns, data }: DataTableProps<TData, TValue>) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((g) => (
          <TableRow key={g.id}>
            {g.headers.map((h) => (
              <TableHead key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

Reach for the bare `<Table>` primitive only for read-only static tables under ~50 rows with no sort or filter. Everything else uses the TanStack-backed `DataTable`.

## Charts with ChartContainer

Build charts with `<ChartContainer>` + Recharts. Never wrap Recharts in a second abstraction. shadcn deliberately does not hide Recharts so the upgrade path stays open; `ChartConfig` handles theming uniformly across chart types.

```tsx
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';

const chartConfig = {
  visitors: { label: 'Visitors', color: 'var(--color-primary)' },
} satisfies ChartConfig;

function Chart({ data }: { data: { day: string; visitors: number }[] }) {
  return (
    <ChartContainer config={chartConfig} className="h-64 w-full">
      <BarChart data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="day" tickLine={false} />
        <Bar dataKey="visitors" fill="var(--color-visitors)" radius={4} />
        <ChartTooltip content={<ChartTooltipContent />} />
      </BarChart>
    </ChartContainer>
  );
}
```

## Adding new components

The CLI is the only distribution channel. Do not copy component source from the docs by hand, and do not install a third-party library for something shadcn ships.

```bash
npx shadcn@latest add dialog
npx shadcn@latest add data-table
npx shadcn@latest search         # search the registry
```

The CLI writes into `components/ui/*`, so subsequent edits are yours to own. Log deviations in `docs/shadcn-deviations.md` so re-adds are a conscious choice.

## Anti-patterns

### Do not re-declare variants in feature code

If you need a new button variant, add it to the `buttonVariants` cva in `components/ui/button.tsx` once. Never define ad-hoc variant maps in a feature module.

### Do not introduce a parallel UI library

No MUI, Chakra, Mantine, Ant, HeroUI, Flowbite, or DaisyUI alongside shadcn. Two systems means two themes, two focus rings, two modal stacks, two sets of tokens — and users notice.

### Do not build a "UI kit" re-exports layer

A `components/common/*` or `components/ds/*` layer that re-exports shadcn primitives with extra props is exactly the abstraction the Open Code philosophy was designed to eliminate. Feature code imports from `@/components/ui/*` directly.

### Do not bespoke-build DatePicker, Combobox, MultiSelect, or CommandPalette

These are the four most common custom reinventions. Every one of them has a canonical shadcn recipe. Use the recipe.

### Do not import from `@radix-ui/*` or `cmdk` in feature code

Those imports bypass the accessible defaults, `data-slot` attributes, theme tokens, and variants that the shadcn layer adds on top.

### Do not fight tailwind-merge with !important

If you cannot style something via variants or className, the primitive is missing a variant — add one, do not paper over it with `!important`.

### Do not hard-code colors

`bg-blue-500`, `text-gray-900`, `#111827` all bypass the theme. Use semantic tokens.

### Do not set icon size via the size prop

`<Icon size={16} />` bypasses Tailwind and makes responsive sizing ugly. Use `className="size-4"`.

## See also

- https://ui.shadcn.com/docs
- https://ui.shadcn.com/docs/tailwind-v4
- https://ui.shadcn.com/docs/forms/react-hook-form
- https://ui.shadcn.com/docs/components/data-table
- https://ui.shadcn.com/docs/components/chart
- https://www.radix-ui.com/primitives/docs/guides/composition
- https://cva.style/docs
- https://tailwindcss.com/blog/tailwindcss-v4
