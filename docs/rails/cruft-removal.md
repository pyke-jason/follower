# Cruft Removal — Error Hoisting & Boundary Validation

CLAUDE.md has the two governing rules ("Hoist errors to the boundary", "No type casts. No `any`."). This doc is the operational companion: concrete anti-patterns to delete on sight, the transformations that replace them, and what to do when a boundary genuinely needs validation.

## The mental model

Interior code runs under a supervisor. Supervisors are the only code that decides what to do when something fails — restart, retry, alert, or give up. Every interior `try/catch` or `.catch(...)` is an assertion that *this* code knows better than the supervisor, which is almost never true.

Likewise for types: a `cast` is the code asserting it knows something the compiler can't verify. At a true boundary (JSON from a DB column, a tool response from an LLM, a Zod object parsed from a request body) this means "parse the input, then trust it." In interior code it means "the types are wrong upstream — fix them there."

## Where boundaries actually are

| Boundary | Where to validate / catch |
|---|---|
| Supervisor loop crash | `src/ingestion/ingest.ts` top-level `try/catch` — sends alert, rethrows |
| HTTP request handler | `src/local-api/middleware/error-handler.ts` or per-route try around `json()` body parsing |
| SignalR / IMAP / Playwright callback edge | The one-and-only callback wrapper — alert + continue so the timer keeps firing |
| LLM tool response | Zod `safeParse` against the tool schema. Failure → `MANUAL_REVIEW` outcome (see `llm-path.ts`) |
| Drizzle JSON column read on legacy rows | Zod `safeParse` against the current schema. Failure → bypass cache / skip row |
| Third-party library error (Databento 4xx, broker reject) | The client that wraps the library — convert foreign error to your domain error type |

Everywhere else: **let it propagate**.

## Anti-patterns, replacements

### 1. Fire-and-forget with swallow

```ts
// ❌
closeBrowser().catch(() => {});
checkExpiryWarnings(...).catch(() => {});
fetch(url).catch(() => {});

// ✅
void closeBrowser();
void checkExpiryWarnings(...);
void fetch(url);
```

`void` tells the TS compiler and the reader "I am intentionally not awaiting this." Unhandled rejections surface in `process.on('unhandledRejection')` if we ever want to wire one up — a `.catch(() => {})` permanently buries the signal.

### 2. Log-and-swallow

```ts
// ❌
try {
  await writeIntent(...);
} catch (err) {
  log.warn('failed to write intent cache', err);
}

// ✅
await writeIntent(...);
```

If `writeIntent` can fail transiently, that's `withBusyRetry`'s job. If it fails permanently, the caller crashes and the supervisor restarts. A `log.warn` turns a recoverable error into a silent data loss.

### 3. Filesystem cleanup "best-effort"

```ts
// ❌
try { unlinkSync(file); } catch {}

// ✅
rmSync(file, { force: true });
```

`{ force: true }` means "missing is fine, no error." No try/catch needed.

### 4. Promise.all with per-promise swallow

```ts
// ❌
await Promise.all([
  doA().catch(() => null),
  doB().catch(() => null),
]);

// ✅
await Promise.allSettled([doA(), doB()]);
// Then inspect results if the caller actually cares about per-item failure.
```

`Promise.allSettled` returns `{status, value|reason}` for each entry — explicit, no hidden nulls.

### 5. Type casts on JSON column reads

```ts
// ❌
const signals = cached.signals as Signal[] | null;

// ✅
const parsed = SignalArraySchema.nullable().safeParse(cached.signals);
if (!parsed.success) {
  log.warn('cached signals failed schema validation — bypassing cache', { issues: parsed.error.issues });
  return /* miss path */;
}
const signals = parsed.data;
```

Drizzle's `$type<>()` doesn't survive `select()` in older patterns. Either migrate the column to `typedJson<T>()` (see `.claude/rules/database-trades.md`), or Zod-parse the value on read. Never cast.

### 6. LLM tool output casts

```ts
// ❌
const taskResult = loopResult.result as TaskResult | null;

// ✅
const parsed = loopResult.result == null
  ? null
  : AgentDecisionSchema.safeParse(loopResult.result);
const taskResult = parsed?.success ? parsed.data : null;
if (loopResult.result != null && parsed && !parsed.success) {
  log.warn('LLM tool response failed schema validation', { issues: parsed.error.issues });
}
```

The LLM can and will drift from the tool schema. Casting hides the drift; Zod parsing surfaces it as a `MANUAL_REVIEW` with a debuggable `issues` payload.

### 7. `: any` on callback or helper params

```ts
// ❌
function onToolCall(result: any) { ... }

// ✅
function onToolCall(result: ToolCallResult) { ... }
// Fix the type at the source — the tool's result schema, the library's
// generic parameter, the helper's signature — not at the call site.
```

If you *cannot* find the right type, ask the user before adding `: any`. Often the library already exports it and nobody imported it.

## What still needs a SAFETY line (user approval required)

Per CLAUDE.md, any retained cast must be approved by the user and marked `// SAFETY:`. Current known candidates (not yet resolved):

- `src/ingestion/signalr.ts` — window global casts for browser-side eval contexts
- `src/broker/databento/databento-tape.ts` — `Readable.from` compat with node/undici type drift
- `src/local-api/routes/web-mutations.ts:243` — `t.legs as unknown[]` (Drizzle JSON drift; should be migrated to `typedJson<TradeLeg[]>()` on schema)
- Several test fixtures use `: any` on mocked db/schema — defer until test refactor

Do not add new SAFETY lines without asking.

## Audit recipe (run before sending a cruft-removal PR)

```bash
# Finds most of the offenders
rg -n "\.catch\(\s*\(?\s*\)?\s*=>\s*\{?\s*\}?\s*\)" src/
rg -n "\bas\s+(any|unknown|[A-Z][A-Za-z0-9_]*)\b" src/
rg -n "@ts-(ignore|expect-error)" src/
rg -n ":\s*any\b" src/
rg -n "try\s*\{[\s\S]{0,200}catch[\s\S]{0,200}log\.(warn|info)" src/ --multiline
```

Each hit is either a known SAFETY line (approved) or a bug. There is no third category.

## Files changed in the 2026-04-16 sweep

See `docs/lessons/2026-04-16-cruft-removal.md` for the specific diffs and the orphan trio (`deterministic-skips.ts`, `prefetch.ts`, `skip-position-alert.ts`) that was investigated but deferred.
