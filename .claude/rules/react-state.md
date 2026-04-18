---
paths: web/src/**
---

# React State Rules

How to choose where state lives in a React 19 + Vite SPA. Each section is imperative: do X, never Y. If a rule sounds arbitrary, read the rationale — edge cases are resolved by understanding why, not by memorizing the rule.

## State taxonomy

State is not one thing. Split it by ownership before picking a tool.

| Kind of state | Owner | Home | Why |
|---|---|---|---|
| Server data (lists, records, mutations) | Backend | TanStack Query | It is an async cache, not state you own |
| Form field values and validation | RHF | React Hook Form + Zod | Uncontrolled inputs, minimal re-renders, single schema |
| Filters, sort, pagination, tab selection, open detail id | URL | `useSearchParams` | Shareable, back/forward, survives reload |
| Current route and path params | Router | React Router 7 | Never duplicate into a store |
| Transient UI (open, hover, hover draft, expanded row) | Component | `useState` | Colocated, cheap, disappears on unmount |
| Interrelated local state (wizard steps, multi-field edits) | Component | `useReducer` | Centralizes transitions in one place |
| Cross-cutting, mostly-static config (theme, auth user, locale, feature flags) | App | Context | Changes rarely; re-renders are free |
| Global client-only UI state (command palette, selection across pages, layout prefs) | App | Zustand 5 | Selector-based subscriptions, no Provider tree |
| Optimistic async update | Component | `useOptimistic` | Built-in rollback on error |
| Form submission pending/error | Form | `useActionState` + `useFormStatus` | Replaces manual `isPending`/`error` state |

Default answer in any ambiguous case: `useState`, local, lifted only when a sibling demands it.

## Decision flow

1. Is it fetched from the server? TanStack Query. Stop.
2. Is it a form field? React Hook Form. Stop.
3. Should a user be able to bookmark, share, or refresh into it? URL search params. Stop.
4. Is it needed by exactly one subtree? `useState` there. Lift only when a sibling demands it.
5. Is it read by many distant components and changes rarely? Context.
6. Is it client-only, changes often, and spans routes or distant branches? Zustand.

Skipping steps produces god-Context and over-Redux'd codebases. Do not start at step 5.

## TanStack Query v5 — server data

TanStack Query is a cache, not state you own. Treat it that way.

### Query keys and options

Use a query-key factory per feature, ordered generic → specific. Hierarchical invalidation falls out for free.

```ts
export const todoKeys = {
  all: ['todos'] as const,
  lists: () => [...todoKeys.all, 'list'] as const,
  list: (f: Filters) => [...todoKeys.lists(), f] as const,
  detail: (id: string) => [...todoKeys.all, 'detail', id] as const,
};
```

Colocate `queryKey` and `queryFn` via `queryOptions()`. It is typesafe, shareable across `useQuery`, `useSuspenseQuery`, `prefetchQuery`, `useQueries`, and its `DataTag` preserves return-type inference for `getQueryData`.

```ts
import { queryOptions } from '@tanstack/react-query';

export const todoDetail = (id: string) =>
  queryOptions({
    queryKey: todoKeys.detail(id),
    queryFn: () => fetchTodo(id),
  });
```

Treat `queryKey` as the dependency array. Any variable used in `queryFn` belongs in the key — missing keys produce stale reads.

### Dependent and conditional queries

Gate with `enabled`, not with `useEffect`.

```ts
useQuery({
  queryKey: ['user', id],
  queryFn: () => fetchUser(id!),
  enabled: Boolean(id),
});
```

### Defaults

Set a non-zero global `staleTime` (30s to 5min per domain). Default `staleTime: 0` causes aggressive refetching. Leave `gcTime` alone.

Leave `refetchOnWindowFocus: true`. In v5 it is driven by `visibilitychange`.

### Mutations

Use `useMutation` for writes. Prefer `invalidateQueries` over `setQueryData` — invalidation re-syncs with the server, which is the whole point.

Return the `invalidateQueries` promise from `onSuccess` to keep the mutation `pending` until refetch completes. Callers can trust `isPending` means "work is not yet visible."

```ts
const mutation = useMutation({
  mutationFn: updateTodo,
  onSuccess: () => queryClient.invalidateQueries({ queryKey: todoKeys.lists() }),
});
```

Put logic side-effects in `useMutation`'s `onSuccess`; put UI side-effects in the `mutate` callback. Unmount cancels `mutate` callbacks, which is what you want for post-submit navigation or toasts.

```tsx
mutation.mutate(values, {
  onSuccess: () => {
    toast.success('Saved');
    navigate('/next');
  },
});
```

Reserve optimistic updates (`onMutate` + rollback in `onError`) for instant-feedback UI only — toggles, likes, reorderings. Do not use them for form submits; failures produce confusing UX.

### Suspense and pagination

Use `useSuspenseQuery` only when data is required to render. Pair with an `<ErrorBoundary>`. `data` is guaranteed defined. Do not use it for optional or conditional queries.

Use `placeholderData: keepPreviousData` for pagination and filters. Placeholder data never enters the cache, so the previous page stays visible without polluting later reads.

```ts
import { keepPreviousData } from '@tanstack/react-query';

useQuery({
  queryKey: todoKeys.list(filters),
  queryFn: () => fetchTodos(filters),
  placeholderData: keepPreviousData,
});
```

Use `useQueries` when the number of queries is dynamic. Its `combine` option derives a single value across results without calling `useMemo` in the consumer.

### Never mirror query data into state

Never copy `data` from a query into `useState`. Copying opts the component out of background updates and window-focus refetches. Read from the query directly, or use the query's `select` option to reshape.

## Zustand 5 — client global state

Zustand is for client-only state that spans distant components. Use it when Context would either re-render too much or grow into a dispatch hub.

### One store per domain

Prefer several small stores over one monolith. Reach for the slices pattern only when two stores must coordinate.

### Export custom hooks, not the raw store

Callers should not know the store shape.

```ts
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

type PaletteState = {
  open: boolean;
  query: string;
  actions: {
    open: () => void;
    close: () => void;
    setQuery: (q: string) => void;
  };
};

const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  query: '',
  actions: {
    open: () => set({ open: true }),
    close: () => set({ open: false, query: '' }),
    setQuery: (query) => set({ query }),
  },
}));

export const usePaletteOpen = () => usePaletteStore((s) => s.open);
export const usePaletteQuery = () => usePaletteStore((s) => s.query);
export const usePaletteActions = () => usePaletteStore((s) => s.actions);
```

### Select narrowly

Never consume the whole store. Selectors that return new objects or arrays on every render cause unnecessary re-renders — wrap them in `useShallow`.

```ts
const { a, b } = usePaletteStore(useShallow((s) => ({ a: s.a, b: s.b })));
```

### Colocate actions under a stable namespace

Put actions in a nested `actions` object and subscribe to the whole object once. The `actions` reference never changes, so consumers that only dispatch never re-render.

### Never store derived values

Derive during render or in a selector. Storing derived state means keeping it in sync — which is what React Compiler and `useMemo` exist to avoid.

### Persist carefully

`persist` hydration is async. Gate UI that depends on persisted state behind `useStore.persist.hasHydrated()`. Version your schema and provide a `migrate` function when the shape changes.

### Tree-scoped stores

For state that logically belongs to a subtree (a wizard, a route, a component's children), create the store inside a Provider. Context carries the *store*, not the state.

### Dev-only devtools

Enable `devtools` middleware only in development. Leaving it on in production leaks store shape and hurts performance.

### Never duplicate server or router state

Do not put query data, URL params, or route state in Zustand. Each has its own source of truth.

## URL search params — shareable state

If a user might reasonably share, bookmark, or refresh into a view, the state belongs in the URL. That includes filters, sort, pagination, tab selection, and the id of an open detail panel.

```tsx
const [params, setParams] = useSearchParams();
const page = Number(params.get('page') ?? '1');

setParams((prev) => {
  prev.set('page', '3');
  return prev;
}, { replace: true });
```

Use `replace: true` for transient updates (typing in a search box) to avoid filling browser history.

### URL drives the query key

Parse params → feed into `queryOptions`. Never mirror URL state into `useState`.

```ts
function useTodos() {
  const [params] = useSearchParams();
  const filters = parseFilters(params);
  return useQuery(todoList(filters));
}
```

### Never put secrets in the URL

No access tokens, PII, or large blobs. Anything in the URL ends up in browser history, analytics, and server logs.

## React Hook Form 7 — form state

RHF is the source of truth for form state. Never mirror field values into `useState` or Zustand — mirroring defeats the uncontrolled-input performance model that is RHF's entire reason to exist.

### Single schema types the form

Use `zodResolver` with one Zod schema that also types the form values.

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const schema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});
type FormValues = z.infer<typeof schema>;

function ProfileForm() {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', name: '' },
  });
  // ...
}
```

### Submit through a mutation

In `onSubmit`, call `mutation.mutate(values)` and use `mutation.isPending` to disable the submit button. Reset the form inside the mutation's `onSuccess`, *after* `invalidateQueries` resolves.

```tsx
const mutation = useMutation({
  mutationFn: saveProfile,
  onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: userKeys.me() });
    form.reset();
  },
});

const onSubmit = form.handleSubmit((values) => mutation.mutate(values));
```

### Seed with `defaultValues`, not Effects

When form defaults come from server data, pass them via `defaultValues` or call `form.reset(data)` once the data loads. Never sync with `useEffect(setValue, [data])` — it runs on every change and fights the user's edits.

## useState and useReducer — local state

Start with `useState` inside the component that needs the value. Move it up or out only when a second component demands it.

### Reach for useReducer when

- Three or more fields change together.
- State has explicit transitions (a wizard step, a modal's open/submitted/error phases).
- You want undo/redo.

```ts
type State = { step: 'idle' | 'submitting' | 'done'; error: string | null };
type Action = { type: 'submit' } | { type: 'ok' } | { type: 'fail'; error: string };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'submit': return { step: 'submitting', error: null };
    case 'ok': return { step: 'done', error: null };
    case 'fail': return { step: 'idle', error: a.error };
  }
}
```

### Never initialize useState from props and expect resync

Initial state is kept only on mount. If child state must reset when a prop changes, use `key` on the child or lift state up.

```tsx
// Good: remount cleanly when id changes
<Profile key={userId} userId={userId} />
```

## Context — semi-static values

Context is a transport, not a state manager. State lives in `useState` or `useReducer`; Context only delivers it.

### Use Context for

- Theme
- Current user / auth
- Locale and i18n
- Feature flags
- A compound component's internal scope (e.g., a custom `<Tabs>` sharing `value` with `<Tab>`)

### One Context per concern

Never a single god-Context holding the whole app's state. Split `ThemeContext`, `AuthContext`, `FormContext`. Colocate each near the subtree that reads it.

### Split state and dispatch

When a `useReducer`'s `dispatch` is stable (it always is), components that only dispatch should not re-render when state changes. Provide two Contexts:

```tsx
<CountStateContext.Provider value={state}>
  <CountDispatchContext.Provider value={dispatch}>
    {children}
  </CountDispatchContext.Provider>
</CountStateContext.Provider>
```

### Wrap Context in a custom hook that throws

Never expose `useContext(X)` directly. Wrap it so missing Providers fail loudly.

```ts
const CountContext = createContext<Value | undefined>(undefined);

export function useCount() {
  const ctx = useContext(CountContext);
  if (!ctx) throw new Error('useCount must be used within CountProvider');
  return ctx;
}
```

Do not pass a `defaultValue` that pretends the Provider is optional. Initialize to `undefined` and let the hook throw.

### Use `use()` for conditional reads

Unlike hooks, `use()` is callable inside `if` blocks, loops, and early returns. Reach for it when a subtree reads a Context only in some cases.

```tsx
function MaybeTheme({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  const theme = use(ThemeContext);
  return <span style={{ color: theme.fg }}>themed</span>;
}
```

### When Context turns into Redux

If two or three Contexts all coordinate one state domain, stop. You are reinventing a weaker version of a store. Move to Zustand or Redux Toolkit.

### Never put server state in Context

Context does not cache, dedupe, revalidate, retry, or cancel. That is what TanStack Query exists for.

## React 19 features

### Actions and `useActionState`

Use `<form action={fn}>` + `useActionState` for form submissions instead of hand-rolled `isSubmitting`/`error` state.

```tsx
const [error, submit, pending] = useActionState(
  async (_prev: string | null, fd: FormData) => {
    const err = await save(fd);
    return err ?? null;
  },
  null,
);

return (
  <form action={submit}>
    <input name="email" />
    {error && <p>{error}</p>}
    <button disabled={pending}>Save</button>
  </form>
);
```

For forms with complex validation, React Hook Form still wins — it owns field-level state and schema validation. `useActionState` shines for simple forms where you would otherwise write `useState` for `isSubmitting` and `error`.

### `useFormStatus`

Use `useFormStatus` in descendant submit buttons instead of prop-drilling `isSubmitting`. The button must be inside the `<form>`.

```tsx
import { useFormStatus } from 'react-dom';

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>Save</button>;
}
```

### `useOptimistic`

Use `useOptimistic` for optimistic UI. Do not hand-roll rollback in `catch` blocks — `useOptimistic` rolls back automatically when the Action throws.

```tsx
const [optimisticTodos, addOptimistic] = useOptimistic(
  todos,
  (state, newTodo: Todo) => [...state, newTodo],
);

async function addTodo(fd: FormData) {
  const draft = { id: crypto.randomUUID(), text: String(fd.get('text')) };
  addOptimistic(draft);
  await saveTodo(draft);
}
```

### `use(promise)`

`use(promise)` integrates a promise with Suspense. The promise must come *from* a parent and be stable — recreating it in the consumer causes infinite rerendering.

In a Vite SPA, TanStack Query's `useSuspenseQuery` is the pragmatic choice for data fetching. Reach for `use(promise)` only when you already hold a stable promise (for example, one created by a router loader equivalent).

### React Compiler

Trust the React Compiler for memoization. Do not pre-add `useMemo`, `useCallback`, or `React.memo` "just in case" — the compiler inserts the right memoization based on what changes.

Keep components pure and idempotent so the compiler can optimize them. Rules:

- Do not mutate props, state, hook arguments, hook returns, or values already passed to JSX.
- Do not read or write refs during render.
- Do not call setters during render.

### No Server Components in Vite

RSC requires a framework (Next.js, Remix, etc.). A Vite SPA uses client-side data fetching (TanStack Query + Suspense) and never writes `'use client'` or imports a `"use server"` directive.

## Anti-patterns

### Do not store derived values in state

Compute during render.

```tsx
// Bad
useEffect(() => setFullName(first + ' ' + last), [first, last]);

// Good
const fullName = `${first} ${last}`;
```

### Do not chain Effects to cascade setters

If `setA` should cause `setB`, compute both synchronously in the handler that fired the original event.

```tsx
// Bad
useEffect(() => { if (a) setB(compute(a)); }, [a]);

// Good — compute in the handler
function onClick() {
  const next = compute(userInput);
  setA(userInput);
  setB(next);
}
```

### Do not notify parents from an Effect

`useEffect(() => onChange(state), [state])` runs after render, fires on every update, and can cause loops. Either lift state up or call `onChange` in the same handler that calls `setState`.

### Do not copy server data into local state

```tsx
// Bad — opts out of background refetch
const { data } = useQuery(todoList(filters));
const [todos, setTodos] = useState(data ?? []);
useEffect(() => { if (data) setTodos(data); }, [data]);

// Good
const { data: todos = [] } = useQuery(todoList(filters));
```

### Do not use useEffect for event logic

If code runs because the user did something, put it in the event handler. Effects are for code that must run because of what is on screen — subscriptions, focus management, external syncing.

### Do not lift state higher than the lowest common ancestor

Lifting too high causes unrelated subtrees to re-render and bloats prop surfaces.

### Do not build a "global" store for page-local state

A store that is only ever read by one route is local state in disguise. Keep it in `useState` or `useReducer`.

### Do not duplicate router state

The URL is the source of truth for the current route and its params. Do not mirror `location.pathname` or `useParams()` into Zustand or Context.

### Do not mutate

Components must be pure and idempotent. Do not mutate props, state, hook arguments, hook returns, or anything passed into JSX. The React Compiler assumes immutability; mutation produces silent miscompilation.

### Do not reinvent form state

If you find yourself tracking `touched`, `dirty`, `errors`, and individual field values with `useState`, stop and reach for React Hook Form.

## See also

- https://react.dev/learn/you-might-not-need-an-effect
- https://react.dev/blog/2024/12/05/react-19
- https://tkdodo.eu/blog/effective-react-query-keys
- https://tkdodo.eu/blog/react-query-as-a-state-manager
- https://tkdodo.eu/blog/working-with-zustand
- https://tanstack.com/query/v5/docs/framework/react/guides/query-keys
- https://zustand.docs.pmnd.rs/guides/slices-pattern
- https://react-hook-form.com/docs
