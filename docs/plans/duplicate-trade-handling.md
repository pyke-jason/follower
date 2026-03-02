# Duplicate Trade Handling: Cross-Message Dedup + Close-All-Matching

## Problem

Hari sent `Short NVDA $175.44 - 1,000 Shares` (msg 469068), then 4 seconds later resent the same text with a trailing backslash (msg 469069). The system created two identical SHORT NVDA positions. When Hari later said `Exit NVDA with $1 profit per share`, `matchPosition()` found 2 matches, couldn't disambiguate, returned `flagReason: "multiple positions found"` → SKIP. Both trades stuck OPEN forever.

Two independent bugs. Two fixes.

---

## Data Analysis (from 76 same-author, same-symbol pairs within 60s)

Of the 76 pairs, 16 are DOUBLE_OPEN_SAME_DIR — the category a dedup would suppress.

- **13 are corrections** (safe to suppress): price typos, trailing punctuation, re-posts
- **3 are genuinely different trades** (false positives under naive attribute match):
  - Tobias AVGO: `$340.60` vs `$346.82` (36s gap) — ambiguous add vs correction
  - MallowMushroom WDC: `$252` vs `$141.22` (49s gap) — clearly different
  - Dave W DBRG: `"lotto"` vs `"next weeks calls for swing"` (28s gap) — different instruments entirely

**Pure text matching** catches exact re-posts but misses price corrections (`$110.2` vs `$110.21`).
**Pure attribute matching** `(author, symbol, direction)` catches price corrections but has 19% false positive rate.
**Neither alone is sufficient.**

---

## Fix 1: Cross-Message Dedup (Prevent Duplicate Opens)

### Design: Layered Check — Text First, Attribute Fallback

Two layers, both cheap, applied in order:

1. **Normalized text match** (high confidence): same author + near-identical `cleanText` within 60s → SKIP. Catches exact re-posts and trailing-punctuation typos.
2. **Attribute match** (lower confidence, tighter window): same `(author, symbol, direction)` within **10 seconds** → SKIP. Catches price corrections like `$110.2` vs `$110.21`. The 10s window is tight enough to avoid the Dave W DBRG case (28s gap) while still catching the Hari case (4s gap).

Either layer triggering produces a SKIP. The layers compose — layer 1 handles most cases; layer 2 catches the residual price-correction pattern that layer 1 misses.

### Where: Inside the Orchestrator, Same Level as Hard-Skip

The dedup check belongs in `resolveOrchestrator()` (orchestrator/index.ts), right after `parseMessage()` and before any I/O or routing. Reasons:

- The parser already runs at line 62 — we have `parse.action`, `parse.direction`, `parse.symbol`
- The orchestrator already returns `SKIP` with reasons — dedup is just another early-exit
- `processTask` stays a dumb bridge — it doesn't make decisions
- The dedup is a **routing decision**, same category as hard-skip, strangle-fork, etc.

```
resolveOrchestrator()
  ├── buildContext()
  ├── parseMessage(ctx)                        ← already here
  ├── if parse.action === 'OPEN' && !parse.isHardSkip:
  │     checkDedup(ctx, parse, env.dedupMap)   ← NEW, same level as hard-skip
  │     if duplicate → return SKIP
  ├── hard skip check                          ← existing
  ├── strangle / open / position / LLM paths   ← existing
  └── on EXECUTE outcome: recordExecution()    ← NEW, at bottom
```

### The DedupMap Injection

The `DedupMap` is injected through `OrchestratorEnv` — same pattern as `llm`, `broker`, `emitter`. The orchestrator doesn't know or care how the map is scoped:

```ts
// In types.ts — OrchestratorEnv addition
export type OrchestratorEnv = {
  getPositions: (symbol?: string) => Promise<OpenPosition[]>;
  llm: LLMProvider;
  broker: BrokerService;
  emitter: SignalEventEmitter;
  dedupMap?: DedupMap;    // ← optional so callers that don't care can omit
};
```

- **Backtest runner** creates a fresh `DedupMap` per run → no cross-run contamination
- **Live runner** creates one at module scope → lives for process lifetime
- **Tests** omit it (optional) → zero impact on existing tests

### Types

```ts
// src/intents/orchestrator/dedup.ts

type DedupEntry = { messageId: number; timestamp: number };
type DedupMap = Map<string, DedupEntry>;

type DedupResult =
  | { type: 'unique' }
  | { type: 'duplicate'; reason: string; originalMessageId: number };

/** Layer 1: normalized text similarity. Window: 60s. */
function checkTextDedup(ctx: OrchestratorContext, dedupMap: DedupMap): DedupResult;

/** Layer 2: attribute match. Window: 10s. */
function checkAttributeDedup(ctx: OrchestratorContext, parse: ParseResult, dedupMap: DedupMap): DedupResult;

/** Composite: runs both layers. */
function checkDedup(ctx: OrchestratorContext, parse: ParseResult, dedupMap: DedupMap): DedupResult;

/** Called after successful EXECUTE to seed the map for future checks. */
function recordExecution(ctx: OrchestratorContext, parse: ParseResult, dedupMap: DedupMap): void;
```

### Text Normalization (Layer 1)

```ts
function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\\|\/\-–—]+$/g, '')   // strip trailing punctuation/slashes
    .replace(/\s+/g, ' ')
    .trim();
}
// Key: `text:${author}:${normalized}`
```

### Attribute Key (Layer 2)

```ts
// Key: `attr:${author}:${symbol}:${direction}`
// Only checked when parse.action === 'OPEN' and direction is non-null
// Window: 10 seconds (tight — catches rapid re-posts, not legitimate separate trades)
```

### Implementation Steps

1. **Create `src/intents/orchestrator/dedup.ts`**
   - Types: `DedupMap`, `DedupEntry`, `DedupResult`
   - `normalizeForDedup(text): string`
   - `checkTextDedup(ctx, dedupMap): DedupResult` — 60s window
   - `checkAttributeDedup(ctx, parse, dedupMap): DedupResult` — 10s window
   - `checkDedup(ctx, parse, dedupMap): DedupResult` — composite
   - `recordExecution(ctx, parse, dedupMap): void` — writes both text + attribute keys
   - Lazy eviction on each check (entries older than 2× max window)
   - Pure functions, no I/O

2. **Update `src/intents/orchestrator/types.ts`**
   - Add `dedupMap?: DedupMap` to `OrchestratorEnv`
   - Export `DedupMap` type

3. **Update `src/intents/orchestrator/index.ts`**
   - After `parseMessage()`, before hard-skip: call `checkDedup()` when `parse.action === 'OPEN'` and `env.dedupMap` exists
   - At bottom of function, when outcome is EXECUTE and `env.dedupMap` exists: call `recordExecution()`
   - Emit SETTLED with `skipCategory: 'cross_message_dedup'`, `phase: 'dedup'`

4. **Update `src/backtest/runner.ts`**
   - Create fresh `DedupMap` per backtest run
   - Pass into `OrchestratorEnv` via the env object built for `processTask`

5. **Update `src/live/runner.ts`**
   - Create module-level `DedupMap`
   - Pass into `OrchestratorEnv`

### Why This Is Modular

- **The dedup module is pure** — no DB, no I/O, no imports from pipeline/broker. Just `OrchestratorContext` + `ParseResult` + a `Map`.
- **The orchestrator owns the decision** — dedup is a routing outcome, same as hard-skip. `processTask` never knows it happened.
- **The map is injected** — callers control scope/lifetime. The orchestrator doesn't manage state.
- **Layers are independent** — can disable either layer, tune windows, or add a third layer (e.g., Levenshtein distance) without touching the orchestrator.
- **Optional by default** — `dedupMap?` means all existing callers and tests work unchanged.

### Edge Cases

| Case | Layer | Window | Outcome |
|------|-------|--------|---------|
| Same text, 4s apart (Hari) | Text | 60s | DEDUP |
| Price typo `$110.2` vs `$110.21`, 5s | Attribute | 10s | DEDUP |
| Price typo `$340` vs `$346`, 36s | Neither | — | ALLOW (too slow for attr, text differs) |
| "lotto" vs "swing calls", 28s (Dave W) | Neither | — | ALLOW (text differs, >10s for attr) |
| CLOSE then re-OPEN same symbol | — | — | ALLOW (only gates OPEN) |
| ADD after OPEN, 30s | — | — | ALLOW (only gates action=OPEN) |
| Live restart | — | — | Cold map, at most 1 missed dedup |
| Backtest determinism | — | — | Uses message timestamps, not wall clock |

---

## Fix 2: Close-All-Matching Positions

### Design: Tagged Union for MatchResult, Clean Switch Dispatch

Replace the `{ position } | { flagReason }` property-sniffing pattern with a proper discriminated union. Clean up `buildTrimLegs` and `buildLegOffLegs` while we're in the file (same smell, "clean as you go").

### New Types (position-path.ts, module-local)

```ts
type MatchResult =
  | { type: 'single';   position: OpenPosition }
  | { type: 'multiple'; positions: OpenPosition[] }
  | { type: 'none';     reason: string };

type LegBuildResult =
  | { type: 'ok';   legs: Leg[] }
  | { type: 'fail'; reason: string };
```

### matchPosition() Changes (lines 72-124)

Return type: `MatchResult` instead of `{ position } | { flagReason }`.

Current terminal branches map to:
- `return { flagReason: ... }` → `return { type: 'none', reason: ... }`
- `return { position: X }` → `return { type: 'single', position: X }`
- New: when `candidates.length > 1` and all share the same direction → `return { type: 'multiple', positions: candidates }`

```ts
// After all filtering, candidates.length > 1:

// All same direction → close-all candidate
const directions = new Set(candidates.map(c => c.direction));
if (directions.size === 1) {
  return { type: 'multiple', positions: candidates };
}

// Mixed directions → genuinely ambiguous
return { type: 'none', reason: `multiple positions for ${symbol} with mixed directions` };
```

### resolvePositionPath() Changes (lines 258-322)

Replace `'flagReason' in matchResult` with switch:

```ts
const matchResult = matchPosition(positions, parse);

switch (matchResult.type) {
  case 'none':
    return { outcome: 'MANUAL_REVIEW', reason: matchResult.reason };

  case 'multiple': {
    if (action !== 'CLOSE') {
      return {
        outcome: 'MANUAL_REVIEW',
        reason: `${action} matched ${matchResult.positions.length} positions for ${symbol} — requires single target`,
      };
    }

    log.info(`closing ${matchResult.positions.length} matching positions for ${symbol}`);

    const signals: ResolvedSignal[] = [];
    for (const pos of matchResult.positions) {
      const legs = buildCloseLegs(pos, symbol);
      if (legs.length === 0) continue;
      signals.push({
        orderType: orderTypeFromLegs(legs),
        legs,
        action: 'CLOSE',
        tradeId: pos.id,
      });
    }

    if (signals.length === 0) {
      return { outcome: 'MANUAL_REVIEW', reason: `no reversal legs for ${matchResult.positions.length} positions` };
    }

    return { outcome: 'EXECUTE', signals };
  }

  case 'single': {
    const { position } = matchResult;
    // existing single-position CLOSE/TRIM/LEG_OFF logic (lines 266-321)
    // but with buildTrimLegs/buildLegOffLegs now returning LegBuildResult
  }
}
```

### buildTrimLegs / buildLegOffLegs Cleanup

Both currently return `Leg[] | { flagReason: string }`. Change to `LegBuildResult`:

```ts
// Before:
function buildTrimLegs(...): Leg[] | { flagReason: string }
// After:
function buildTrimLegs(...): LegBuildResult

// Callers change from:
if ('flagReason' in result) { ... }
// To:
if (result.type === 'fail') { ... }
```

### Why No Downstream Changes

- `OrchestratorResult.signals` is already `ResolvedSignal[]` — any length
- `executeResolvedSignals()` already loops sequentially (execute-resolved.ts)
- Each signal carries `tradeId` → `recordTrade()` targets the right trade
- Each signal gets independent pricing + order placement

### Implementation Steps

1. **Define `MatchResult` and `LegBuildResult` types** at top of `position-path.ts`

2. **Update `matchPosition()`** — change return type to `MatchResult`, map all return sites:
   - `{ flagReason: X }` → `{ type: 'none', reason: X }`
   - `{ position: X }` → `{ type: 'single', position: X }`
   - Add `{ type: 'multiple', positions: candidates }` when same-direction multi-match

3. **Update `buildTrimLegs()` and `buildLegOffLegs()`** — return `LegBuildResult`

4. **Rewrite `resolvePositionPath()` dispatch** — switch on `matchResult.type`, add `case 'multiple'` for close-all

5. No changes to `types.ts`, `execute-resolved.ts`, or `orchestrator/index.ts`

### Edge Cases

| Case | Outcome | Why |
|------|---------|-----|
| 2 identical positions, CLOSE | Close both | Same direction → `type: 'multiple'` |
| 3+ identical positions, CLOSE | Close all | Loop builds one signal per position |
| Mixed quantities (28 + 14 shares) | Each closes own size | `buildCloseLegs()` uses `position.quantity` |
| TRIM with 2 positions | MANUAL_REVIEW | TRIM needs single target |
| LEG_OFF with 2 positions | MANUAL_REVIEW | LEG_OFF needs single target |
| 1 LONG + 1 SHORT same symbol | MANUAL_REVIEW | Mixed directions → `type: 'none'` |
| Single position | Existing path | `type: 'single'` → no behavior change |

---

## Fix Interaction

**Complementary, not redundant:**

- **Fix 1** prevents new duplicates from being created
- **Fix 2** handles duplicates that already exist in the DB AND handles legitimate multi-position scenarios (trader scales in over minutes/hours, then exits with one "close" message)

---

## Pre-Existing Bug Found (Separate Fix)

`resolveAddPath()` in `open-path.ts` (lines 577-627) silently degrades to OPEN when multiple positions match an ADD. Should return MANUAL_REVIEW instead.

---

## Files Changed

| File | Fix | Change |
|------|-----|--------|
| `src/intents/orchestrator/dedup.ts` | 1 | NEW — layered dedup check (text + attribute) |
| `src/intents/orchestrator/types.ts` | 1 | Add `dedupMap?: DedupMap` to `OrchestratorEnv` |
| `src/intents/orchestrator/index.ts` | 1 | Dedup gate after parse, recordExecution after EXECUTE |
| `src/backtest/runner.ts` | 1 | Create DedupMap per run, pass into env |
| `src/live/runner.ts` | 1 | Create module-level DedupMap, pass into env |
| `src/intents/orchestrator/position-path.ts` | 2 | `MatchResult` + `LegBuildResult` tagged unions, close-all branch |

Total: 1 new file, 5 modified files.
