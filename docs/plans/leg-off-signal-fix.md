# Fix: LEG_OFF action lost between orchestrator and executor

## Problem

The orchestrator correctly parses LEG_OFF signals ("Bought back the short Calls on META holding the long Calls") but `ResolvedSignal` has no `action` field. The executor re-derives action via `deriveAction()` which always returns `CLOSE` for anything with a `tradeId` that isn't a TRIM. So `recordTrade()` fully closes the position instead of mutating it in-place (CDS → CALL).

Result: the META CDS $755/$765 trade gets killed on the leg-off message, and "Exit META CDS at break-even" finds no open position.

The evals pass because they only test the orchestrator. The backtest fails because it actually executes.

## Root cause trace

```
Orchestrator (correct):
  parse: action=LEG_OFF symbol=META strategy=CALL targetStrategy=CALL
  position-path: builds single reversal leg (BUY back the $765 SELL leg)
  → ResolvedSignal { orderType: 'SINGLE', legs: [...], tradeId: '7a57...' }
                     ↑ no action field, no targetStrategy

Executor (broken):
  deriveAction(signal) → has tradeId, not TRIM → returns 'CLOSE'
  recordTrade({ action: 'CLOSE', ... }) → full close, position gone

recordTrade LEG_OFF branch (never reached):
  if (action === 'LEG_OFF') { ... }  // action is 'CLOSE', skipped
```

## Fix

### 1. Add `action` + `targetStrategy` to ResolvedSignal

**`src/intents/orchestrator/types.ts`** — ResolvedSignal (line 43)

No new types. `action` reuses the union already in ParseResult/RecordTradeInput. `targetStrategy` reuses the `Strategy` enum.

```ts
export type ResolvedSignal = {
  action: 'OPEN' | 'CLOSE' | 'TRIM' | 'LEG_OFF';
  orderType: 'SINGLE' | 'SPREAD' | 'STOCK';
  legs: Leg[];
  limitPrice?: number;
  tradeId?: string;
  exitPercent?: number;
  /** LEG_OFF only: the strategy the position converts to after removing a leg. */
  targetStrategy?: Strategy;
};
```

### 2. Set action on every signal construction site (6 total)

| Site | File | Action |
|---|---|---|
| position-path.ts:318 | CLOSE/TRIM/LEG_OFF resolver | `action` from local var + `targetStrategy` for LEG_OFF |
| open-path.ts:433 | STOCK open | `action: 'OPEN'` |
| open-path.ts:461 | Premium-match scan | `action: 'OPEN'` |
| open-path.ts:547 | Main spread/option path | `action: 'OPEN'` |
| index.ts:~265 | `resolveStrangleExit()` | `action: 'CLOSE'` |
| index.ts: ADD path | `resolveAddPath()` stamps tradeId on signals from resolveOpenPath | Overwrite `action: 'ADD'` alongside tradeId |

**llm-path.ts needs no changes** — it delegates to `resolveOpenPath`/`resolvePositionPath` which set action.

### 3. Delete `deriveAction()` in executor

**`src/pipeline/execute-resolved.ts`**

- Delete `deriveAction()` (lines 155-165) entirely
- Replace `const action = deriveAction(signal)` with `const action = signal.action`
- For LEG_OFF: pass `strategy: signal.targetStrategy` to recordTrade (what the trade becomes), keep `deriveStrategy()` for order building (describes the reversal order shape)

### 4. Simplify `recordTrade` LEG_OFF branch — derive keptLeg internally

**`src/trades/record-trade.ts`** (~line 320)

Stop reading `targetStrategy`/`keptLeg`/`closedLeg` from the opaque metadata bag. Derive from what's already available:
- `strategy` param = targetStrategy (what the trade becomes)
- `legs` param = the closed leg reversal
- `existing.legs` = the current spread legs
- keptLeg = existing.legs minus closed legs (matched by OCC symbol — same `formatOccSymbol` on both sides)

**Still write** `{ targetStrategy, closedLeg, keptLeg }` to event metadata — `rebuild.ts:111` reads them back for replay.

### 5. Bonus: add LEG_OFF to backtest timestamp guard

`record-trade.ts` lines 103-109 check `CLOSE || TRIM` but not `LEG_OFF`. Pre-existing bug — fix while in the file.

## Files to modify

| File | Change |
|---|---|
| `src/intents/orchestrator/types.ts` | Add `action`, `targetStrategy` to ResolvedSignal |
| `src/intents/orchestrator/position-path.ts` | Set `action` + `targetStrategy` on signal |
| `src/intents/orchestrator/open-path.ts` | Set `action: 'OPEN'` on 3 signal sites |
| `src/intents/orchestrator/index.ts` | Set `action: 'CLOSE'` in strangle exit, `action: 'ADD'` in ADD path |
| `src/pipeline/execute-resolved.ts` | Delete `deriveAction()`, use `signal.action`, pass targetStrategy for LEG_OFF |
| `src/trades/record-trade.ts` | Derive keptLeg internally, still write to event metadata, fix timestamp guard |

## What gets deleted

- `deriveAction()` function and its comments
- metadata bag reads in recordTrade LEG_OFF branch

## Verification

1. Type check: `npx tsc --noEmit`
2. META CDS evals: `npx tsx scripts/eval-orchestrator.ts --case legoff-adv-008 && --case legoff-adv-009 && --case legoff-adv-010`
3. Full eval suite: `npx tsx scripts/eval-orchestrator.ts`
4. Re-run backtest: verify META trade shows LEG_OFF event, position mutates CDS→CALL, exit message finds open position
