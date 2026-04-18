---
paths: web/src/**
---

# React Composition Rules

How to shape components so they stay readable, reusable, and fast. React 19 conventions: `ref` is a prop, `forwardRef` is retired in new code, compound components use internal Context, and `asChild` replaces the `as` prop. Every rule has a rationale — users need to judge edge cases, not parrot the rule.

## Pattern selection

| Situation | Pattern |
|---|---|
| Component wraps arbitrary content (Card, Panel, Modal body) | `children` prop |
| Parent needs to pass data through layers that do not read it | Pass JSX as `children` instead of drilling props |
| Related parts share implicit state (Select, Tabs, Accordion, Dialog) | Compound components + internal Context |
| Fixed set of named regions (header, body, footer, sidebar, main) | Named slot props |
| Rendered element must change (button vs anchor vs router `Link`) | `asChild` + Radix `<Slot>` |
| List of unknown-length items from data | Plain `.map()`, not compound components |
| Reuse logic across unrelated components | Custom hook |
| Headless list or virtualization with per-row customization | Render prop / function-as-children |
| Form field that "just works" but stays overridable | Controlled + uncontrolled dual API (`value` + `defaultValue`) |
| You reach for Context to avoid prop drilling | Try composition with `children` first |
| A subtree re-renders when one sibling's state changes | Lift content up into `children`; move state down |

## Default to `children`

Before inventing any other prop, try `children`. It is the most flexible composition primitive React provides and the cheapest to understand.

```tsx
function Card({ children }: { children: React.ReactNode }) {
  return <div className="card">{children}</div>;
}
```

If a component takes `headerLeft`, `headerRight`, and `footerActions` props that each render arbitrary content, you have reinvented `children`. Prefer named slots (below) or compound components.

## Solve prop drilling with composition before Context

Two or three levels of explicit props is not "drilling" — it is traceable data flow. Lift the reader component up and pass it as `children` instead of threading the data through intermediate components.

```tsx
// Bad: Layout carries data it never reads
<Layout posts={posts} sidebar={sidebar} user={user} />

// Good: Layout knows nothing about posts
<Layout>
  <Sidebar />
  <PostList posts={posts} />
</Layout>
```

If an intermediate component receives a prop it never uses, you forgot to compose.

## Lift content up, push state down

To stop a subtree from re-rendering when a sibling's state changes, either move the state into a smaller child, or lift the unchanging JSX up into the parent and pass it as `children`. This is almost always the right move before reaching for `React.memo` or `useMemo`.

## Compound components for shared implicit state

When sibling parts coordinate through shared state (Tabs, Accordion, Select, Dialog, RadioGroup), the parent owns state via Context and children read it via a scoped hook that throws when used outside the provider.

```tsx
import { createContext, useContext, useState } from 'react';

type TabsContextValue = {
  value: string;
  setValue: (v: string) => void;
};

const TabsContext = createContext<TabsContextValue | undefined>(undefined);

function useTabsContext() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('Tabs.* must render inside <Tabs>');
  return ctx;
}

function Tabs({
  value,
  onValueChange,
  defaultValue = '',
  children,
}: {
  value?: string;
  onValueChange?: (v: string) => void;
  defaultValue?: string;
  children: React.ReactNode;
}) {
  const [internal, setInternal] = useState(defaultValue);
  const current = value ?? internal;
  const set = (v: string) => {
    setInternal(v);
    onValueChange?.(v);
  };
  return (
    <TabsContext.Provider value={{ value: current, setValue: set }}>
      {children}
    </TabsContext.Provider>
  );
}

function TabsList({ children }: { children: React.ReactNode }) {
  return <div role="tablist">{children}</div>;
}

function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  const { value: current, setValue } = useTabsContext();
  return (
    <button role="tab" aria-selected={current === value} onClick={() => setValue(value)}>
      {children}
    </button>
  );
}

function TabsContent({ value, children }: { value: string; children: React.ReactNode }) {
  const { value: current } = useTabsContext();
  if (current !== value) return null;
  return <div role="tabpanel">{children}</div>;
}

Tabs.List = TabsList;
Tabs.Trigger = TabsTrigger;
Tabs.Content = TabsContent;
```

Usage:

```tsx
<Tabs defaultValue="a">
  <Tabs.List>
    <Tabs.Trigger value="a">A</Tabs.Trigger>
    <Tabs.Trigger value="b">B</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="a">Panel A</Tabs.Content>
  <Tabs.Content value="b">Panel B</Tabs.Content>
</Tabs>
```

### Never walk children with cloneElement

Do not use `React.Children.map` + `cloneElement` to wire compound components. It breaks when children are wrapped, filtered, conditionally rendered, or passed through a fragment. Internal Context handles all those cases for free.

### Attach subcomponents with dot notation

`Select.Trigger`, `Select.Content`, `Select.Item` makes membership obvious and gives editors one import per family. The root is the public name; the parts are its static properties.

### Throw when used outside the provider

A compound child without its provider is always a bug. Throw a loud, named error. Silent `undefined` returns produce impossible-to-debug renders.

## Named slots over compound parts when structure is fixed

When the layout has a fixed set of regions (header, sidebar, main, footer) and the order is not up to the caller, named slot props beat compound components.

```tsx
function PageShell({
  header,
  sidebar,
  children,
}: {
  header?: React.ReactNode;
  sidebar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="shell">
      {header && <header>{header}</header>}
      {sidebar && <aside>{sidebar}</aside>}
      <main>{children}</main>
    </div>
  );
}

<PageShell header={<NavBar />} sidebar={<Nav />}>
  <Content />
</PageShell>;
```

Reach for a named slot over a compound part when the slot is optional, singular, and not sharing state with other parts.

## asChild and Radix Slot

To let callers change the rendered element (button to anchor to `Link`), accept an `asChild` prop and render through Radix's `<Slot>`. `Slot` merges your component's props, classes, event handlers, and ref onto a single child element.

```tsx
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

type ButtonProps = React.ComponentProps<'button'> & {
  asChild?: boolean;
};

function Button({ asChild, className, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn('btn', className)} {...props} />;
}
```

Usage:

```tsx
<Button asChild>
  <Link to="/profile">Profile</Link>
</Button>
```

### Never use an `as` prop for polymorphism in new code

`as` prop polymorphism in TypeScript requires a generic `as` parameter plus conditional element props — the generics tank type-check performance at scale and rarely infer cleanly. `asChild` delegates element choice to the call site without any generic gymnastics.

### Children under asChild must spread props and forward ref

If the child drops props, focus rings and click-outside handlers stop working. If the child drops `ref`, Radix loses its anchor. In React 19, accept `ref` as a normal prop and spread the rest:

```tsx
function LinkButton({ ref, className, children, ...rest }: React.ComponentProps<'a'>) {
  return (
    <a ref={ref} className={cn('underline', className)} {...rest}>
      {children}
    </a>
  );
}

<Button asChild>
  <LinkButton href="/x">Go</LinkButton>
</Button>;
```

### asChild event handler order

The child's handler runs first; if the child calls `event.preventDefault()`, the slot's handler is skipped. If both must fire, neither should cancel.

## Controlled and uncontrolled dual API

Stateful primitives (Tabs, Select, Dialog, Switch, inputs) should accept both patterns:

- Controlled: `value` + `onValueChange`, parent owns state.
- Uncontrolled: `defaultValue`, component owns state internally.

```tsx
function useControllableState<T>(options: {
  value?: T;
  defaultValue: T;
  onChange?: (v: T) => void;
}) {
  const [internal, setInternal] = React.useState(options.defaultValue);
  const isControlled = options.value !== undefined;
  const value = (isControlled ? options.value : internal) as T;
  const setValue = (next: T) => {
    if (!isControlled) setInternal(next);
    options.onChange?.(next);
  };
  return [value, setValue] as const;
}
```

### Default to uncontrolled; require controlled only when the parent must observe

Most callers want "it just works." Controlled mode is for when the parent needs to read or override the state.

### A prop must not flip between controlled and uncontrolled

Either `value` is always passed or never passed across renders. Switching produces warnings and silent state loss. Components should not "upgrade" from uncontrolled to controlled partway through their lifetime.

## ref as a prop (React 19)

Do not write `forwardRef` in new code. React 19 passes `ref` as a normal prop on function components.

```tsx
// React 19 — new code
type InputProps = React.ComponentProps<'input'>;

function Input({ ref, className, ...props }: InputProps) {
  return <input ref={ref} className={cn('input', className)} {...props} />;
}

// Usage
const ref = useRef<HTMLInputElement>(null);
<Input ref={ref} placeholder="Name" />;
```

`forwardRef` still works for compatibility, but new code should not use it. Components that already use `forwardRef` can be migrated incrementally when touched.

## Typing spread-friendly components

Use `ComponentProps` (React 19) or `ComponentPropsWithoutRef` (pre-19) to extend native element types. Never hand-roll `HTMLAttributes<HTMLInputElement> & RefAttributes<...>`.

```tsx
type InputProps = React.ComponentProps<'input'> & {
  label: string;
  error?: string;
};

function TextField({ label, id, className, error, ref, ...rest }: InputProps) {
  return (
    <label htmlFor={id} className={cn('field', className)}>
      <span>{label}</span>
      <input id={id} ref={ref} {...rest} />
      {error && <span className="error">{error}</span>}
    </label>
  );
}
```

Always destructure the props you consume, then spread `...rest` onto the root DOM node. Forgotten spreads break className merging, ARIA, data attributes, and event handlers.

## Custom hooks over render props and HOCs

For reusing *behavior* (selection, disclosure, hover, clipboard, keyboard shortcuts), prefer custom hooks. They compose linearly, keep JSX flat, and avoid the wrapper trees that HOCs and render props produce.

```ts
function useDisclosure(defaultOpen = false) {
  const [open, setOpen] = React.useState(defaultOpen);
  return {
    open,
    onOpenChange: setOpen,
    openDialog: () => setOpen(true),
    closeDialog: () => setOpen(false),
    toggle: () => setOpen((v) => !v),
  };
}
```

### Render props are for headless iteration

Keep render props (function-as-children) for cases where the library renders a tree the consumer cannot own — virtualization, headless tables, drag-sortable lists. A hook cannot render thousands of rows for you; a render prop can.

```tsx
<VirtualList items={rows}>
  {(row) => <Row key={row.id} {...row} />}
</VirtualList>
```

### HOCs are legacy

Do not write new HOCs. They stack wrapper components, obscure types, and compose badly. Hooks replace almost every HOC use case.

## Retire container / presentational

The container/presentational split was a workaround for a pre-hooks React. In 2026, replace it with custom hooks: put data fetching and logic in a hook (`useProfile()`), keep the component focused on rendering.

```tsx
function Profile({ id }: { id: string }) {
  const { data, isLoading } = useProfile(id);
  if (isLoading) return <Skeleton />;
  return <ProfileCard profile={data} />;
}
```

One file, two concerns cleanly separated, no "connected" wrapper.

## When to break up components

Do not split preemptively. Split when you hit an actual problem:

- Re-render cost — only an expensive subtree needs to be hoisted out.
- Genuine reuse — two call sites need the same sub-render.
- Testing friction — the component does too much to test narrowly.
- State tangling — multiple concerns share one piece of state unnecessarily.

Duplication is cheaper than the wrong abstraction. Kent Beck's rule of three applies: extract when you have three uses, not two.

### A function that returns JSX is a component

If a helper inside a component returns JSX and exceeds a handful of lines, extract it. Inline `renderX` helpers compound render cost and obscure where state lives.

## Context value stability

When a Context carries both data and functions, memoize the value and split by update frequency.

```tsx
function Provider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = React.useState(0);
  const increment = React.useCallback(() => setCount((c) => c + 1), []);
  const value = React.useMemo(() => ({ count, increment }), [count, increment]);
  return <CounterContext.Provider value={value}>{children}</CounterContext.Provider>;
}
```

If `dispatch` is stable but `state` changes often, split into two Contexts so consumers that only dispatch do not re-render. The React Compiler covers most of this, but the split still matters for large trees.

## Factory pattern for generic primitives

Design-system primitives that share a generic (typed RadioGroup, typed Select) should be returned from a factory. Otherwise TypeScript cannot tie the parent's generic to each child's prop.

```ts
function createRadioGroup<T>() {
  const Group = (props: {
    value: T;
    onValueChange: (v: T) => void;
    children: React.ReactNode;
  }) => {
    /* ... */
  };
  const Item = (props: { value: T; children: React.ReactNode }) => {
    /* ... */
  };
  return { Group, Item };
}

const { Group: StatusGroup, Item: StatusItem } = createRadioGroup<'ok' | 'warn' | 'fail'>();
```

## Anti-patterns

### Do not `cloneElement` children

`React.Children.map` + `cloneElement` breaks on wrapped, filtered, fragment-nested, or conditional children. Use internal Context.

### Do not invent `headerLeft`, `headerRight`, `footerActions`

Those are `children` with extra steps. Accept `children`, or named slots if the layout is fixed.

### Do not initialize Context with a fake default

`createContext({ value: 0, setValue: () => {} })` hides missing Providers. Initialize to `undefined` and throw in the custom hook.

### Do not write `forwardRef` in new code

React 19 passes `ref` as a prop. Migrate existing `forwardRef` only when you are already editing the file.

### Do not use an `as` prop

Use `asChild` + `Slot`. The TypeScript cost of generic `as` polymorphism is not worth it.

### Do not build a container component per screen

Put fetching and logic in a custom hook. One file, two concerns, no wrappers.

### Do not split components preemptively

Duplication is cheaper than the wrong abstraction. Split on real pain: re-render cost, genuine reuse, testing friction, tangled state.

### Do not type with `HTMLAttributes<T>` by hand

Use `React.ComponentProps<'element'>`. It composes cleanly and carries everything including `ref`.

### Do not memoize everything

The React Compiler handles most memoization. Pre-adding `useMemo` / `useCallback` / `React.memo` obscures intent without measurable wins. Measure before memoizing.

## See also

- https://react.dev/learn/passing-props-to-a-component
- https://react.dev/learn/passing-data-deeply-with-context
- https://www.radix-ui.com/primitives/docs/utilities/slot
- https://www.radix-ui.com/primitives/docs/guides/composition
- https://kentcdodds.com/blog/compound-components-with-react-hooks
- https://kentcdodds.com/blog/when-to-break-up-a-component-into-multiple-components
- https://overreacted.io/before-you-memo/
- https://tkdodo.eu/blog/building-type-safe-compound-components
