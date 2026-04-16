# Orchestrator Signal Tracking

Every message that passes through the orchestrator must produce `Signal[]`. One Signal = one trade. This is how we compare the system's classification against ground-truth labels.

## The problem today

Three types describe the same concept at different abstraction levels:

| Type | Where | Stored? |
|------|-------|---------|
| `ParseResult` | parser.ts output | Opaque blob in `run_decisions.snapshot` |
| `Signal` | LLM tool output | `message_intents.signals` — **LLM path only** |
| `ResolvedSignal` | orchestrator output | Opaque blob in `run_decisions.snapshot` |

`ParseResult` and `Signal` have the same classification fields with different names. `ParseResult` also carries routing metadata (complexity flags, skip reasons) that are mixed in with the classification fields instead of being separate.

The deterministic path never produces `Signal` at all — it jumps straight from `ParseResult` to `ResolvedSignal`. So there's nothing to compare against labels for the majority of messages.

## The fix: Signal is the universal output

The orchestrator produces `Signal[]` for every message, regardless of path. LLM and deterministic produce the same output type. The path taken is metadata on each Signal, not a structural difference.

### Signal carries its own routing context

Routing metadata belongs on each Signal (per-trade), not at the message level. One message can contain a strangle (complex → LLM) and a stock exit (simple → deterministic). Each trade routes independently.

```ts
Signal {
  // Classification — what the trader said (same fields labels use)
  action:        OPEN | EXIT | TRIM
  symbol:        string
  strategy:      STOCK | CALL | PUT | CDS | PDS | PCS | CCS | STRANGLE | null
  legs:          SignalLeg[]
  statedPrice:   number | null
  quantity:      number | null
  exitFraction:  number | null

  // Routing metadata — how to process this trade (per-trade, not per-message)
  route:         'hard-skip' | 'deterministic' | 'llm' | null
  skipReason:    string | null        // why it was skipped (if skip)
  confidence:    number | null        // parser certainty — low routes to LLM
}
```

This is one type. Both paths fill the same fields. The `route` tag is observability, not a different type.

### ParseResult goes away

`ParseResult` is replaced by `Signal[]` production directly. The parser's job:
1. Extract classification fields → `Signal` per trade
2. Set `route` and `confidence` per Signal based on complexity analysis
3. Return `Signal[]`

What were global flags become per-Signal:
- `isHardSkip` → `Signal.route = 'hard-skip'` + `Signal.skipReason`
- `isStrangle` → `Signal.strategy = 'STRANGLE'` (one Signal, not two)
- `isLotto` → could be a flag on the Signal or just influence `confidence`
- `complexityFlags` → drive `Signal.confidence` and `Signal.route`

### ResolvedSignal stays separate

`ResolvedSignal` is the broker instruction — concrete legs with OCC symbols, limit prices, order types. It's a different abstraction (execution, not classification). The pipeline is:

```
Message → parser → Signal[] → orchestrator routing → ResolvedSignal[] → broker
                      ↓
               message_intents (stored for eval comparison)
```

## Storage

Every message writes its `Signal[]` to `message_intents.signals`. Every route. Including hard-skips (which produce `[]` or a Signal with `route: 'hard-skip'`).

For LLM path: the LLM's own Signal output takes precedence over the parser's initial classification (the LLM may correct the parser).

For deterministic path: the parser's Signal output is written directly.

Comparison is then:

```
eval_labels.label.signals:    Signal[]   ← ground truth
message_intents.signals:      Signal[]   ← system output (every route)
```

Join on `messageId`. Same type on both sides.

## What changes

| Current | After |
|---------|-------|
| `ParseResult` type in `types.ts` | Removed. Parser returns `Signal[]` directly. |
| `SerializedParseResult` | Removed. Signal is already serializable. |
| `emitOrchestratorEvents` writes signals only for LLM | Writes signals for all routes |
| `resolveOrchestrator` takes `ParseResult`, routes through separate paths | Takes `Signal[]`, routes each Signal independently based on `Signal.route` |
| Strangle = two separate Signals forced by inner array | One Signal with `strategy: STRANGLE` |

### What does NOT change

- `ResolvedSignal` — broker instructions, different abstraction
- `run_decisions` — execution outcomes, not classifications
- `eval_labels` — ground truth (consumes Signal, doesn't produce it)
- Backtest runner — already runs through orchestrator, gets Signal tracking for free

## Migration path

1. **Now:** Add `parseResultToSignals()` bridge function. Convert after parsing, write to `message_intents` for all routes. ParseResult still exists internally but Signal[] is always produced.
2. **Next:** Refactor parser to return Signal[] directly. Kill ParseResult type.
3. **Then:** Refactor orchestrator routing to operate on Signal[] instead of ParseResult.
