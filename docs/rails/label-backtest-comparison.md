# Eval: Ground Truth, Classification, Comparison

The eval system exists to answer one question: **is the classifier getting the right answer?** Everything else — deterministic shortcuts, orchestrator optimizations, backtest P&L — is downstream. If you can't measure accuracy, you can't improve anything.

## Principles

1. **Ground truth first.** Human-verified labels are the only reliable baseline. Without them, every metric is circular.
2. **LLM classifies every message.** The system produces `Signal[]` for every message via the LLM. This is the system's answer.
3. **Compare.** Label `Signal[]` vs system `Signal[]`. Same type, direct comparison. Now you have real accuracy numbers.
4. **Only then optimize.** Deterministic shortcuts (hard-skip, parser) earn their place by proving they match or beat the LLM on measured accuracy. Not assumed. Measured.

The current system was built in the wrong order — the orchestrator was optimized before reliable eval existed. The result: the orchestrator can't be trusted, and the evals can't be trusted either. This doc describes how to fix that.

## Signal redesign

### Problem

Today:
- Labels store `Signal[][]` (outer = trades in message, inner = legs of one trade)
- `message_intents` stores `Signal[]` (flat, only populated for LLM route)
- The deterministic path produces `ResolvedSignal[]` and never creates `Signal` at all
- There is no reverse mapping from `ResolvedSignal` → `Signal`

The `Signal[][]` nesting exists solely because strangles are represented as two separate Signals (one CALL, one PUT). Every other strategy — CDS, PDS, PCS, CCS, single options, stock — is already one Signal.

### Fix

**One Signal = one trade. Always.**

One Signal = one trade. Always. The current Signal's per-leg fields push down into a leg structure so any multi-leg trade (strangles, calendars, iron condors) is one Signal.

```
Signal {
  action:       OPEN | EXIT | TRIM
  symbol:       string                    // underlying ticker
  strategy:     STOCK | CALL | PUT | CDS | PDS | PCS | CCS | STRANGLE | null
  legs:         SignalLeg[]               // per-leg detail; empty for bare trades ("Long MP")
  // Informational — capture if stated, don't fail comparison if missing
  statedPrice:  number | null             // net price for the whole trade
  quantity:     number | null             // shares or contracts
  exitFraction: number | null             // 0.5 = half out; null = unknown partial or full exit
}

SignalLeg {
  type:   CALL | PUT | STOCK
  strike: number | null
  expiry: string | null                   // as stated: "Oct (17)", "next week"
  side:   BUY | SELL | null               // null when not determinable from message
}
```

**Design choices:**

- **Three actions.** OPEN = entering (includes adding to a position). EXIT = full close. TRIM = partial close (includes leg-off). ADD and LEG_OFF were orchestrator implementation details, not trader intent.
- **No direction field.** LONG/SHORT is the trader's market view, not the trade mechanics. Credit vs debit is fully determined by `strategy` + `legs[].side`. The legs tell you everything the system needs.
- **Informational fields are soft.** `statedPrice`, `quantity`, `exitFraction` are captured when the trader states them but are not comparison-critical. "Partial profits" → `action: TRIM, exitFraction: null`. "Half out" → `exitFraction: 0.5`. "30% profit" → not a sizing field, ignore. The system doesn't copy these values — it sizes from its own config and uses live quotes.
- **Legs for structure.** A bare "Long MP" has `legs: []` and `strategy: null`. A PCS has two PUT legs with explicit sides. A strangle has a CALL leg and a PUT leg. A calendar has two legs with different expiries. Any structure works.

**Examples:**

```
"Long TSLA $311.83 - 1,000 Shares"
→ { action: OPEN, symbol: TSLA, strategy: STOCK,
    legs: [{ type: STOCK, strike: null, expiry: null, side: BUY }],
    statedPrice: 311.83, quantity: 1000 }

"Long GLW PCS 68/67 for .63 credit"
→ { action: OPEN, symbol: GLW, strategy: PCS,
    legs: [{ type: PUT, strike: 68, side: SELL },
           { type: PUT, strike: 67, side: BUY }],
    statedPrice: 0.63 }

"Exit Short ELV 276.45"
→ { action: EXIT, symbol: ELV, strategy: STOCK,
    legs: [{ type: STOCK, strike: null, expiry: null, side: BUY }] }

"Strangle AAPL 180C/170P"
→ { action: OPEN, symbol: AAPL, strategy: STRANGLE,
    legs: [{ type: CALL, strike: 180, side: BUY },
           { type: PUT, strike: 170, side: BUY }] }

"Trim half JOBY"
→ { action: TRIM, symbol: JOBY, strategy: null, legs: [], exitFraction: 0.5 }

"Partial profits NVDA"
→ { action: TRIM, symbol: NVDA, strategy: null, legs: [], exitFraction: null }

"Calendar AAPL May/June 190 calls"
→ { action: OPEN, symbol: AAPL, strategy: CALENDAR,
    legs: [{ type: CALL, strike: 190, expiry: "May", side: BUY },
           { type: CALL, strike: 190, expiry: "June", side: SELL }] }
```

Labels become:

```
EvalLabelData {
  reasoning:   string
  isTrade:     boolean
  confidence:  HIGH | LOW
  signals:     Signal[]    // one per trade in the message
}
```

`Signal[]` everywhere. Labels, LLM output, message_intents. One type, one shape, direct comparison.

### Comparison fields

| Must match | Comparison | Why |
|---|---|---|
| `action` | Exact | OPEN vs EXIT vs TRIM is the core question |
| `symbol` | Case-insensitive | Wrong ticker = wrong trade |
| `strategy` | Case-insensitive | Wrong structure = wrong trade |
| `legs` | Type + strike + side match per leg | The trade mechanics |

| Informational (soft) | Comparison | Why |
|---|---|---|
| `legs[].expiry` | Case-insensitive if both present | Often missing or ambiguous |
| `statedPrice` | ±0.01 if both present | System uses live quotes, not stated price |
| `quantity` | Exact if both present | System sizes independently |
| `exitFraction` | ±0.05 if both present | "About half" vs "half" |

### Migration

- `EvalLabelData.trades: Signal[][]` → `EvalLabelData.signals: Signal[]` (flatten)
- `Signal.strikes` → `SignalLeg[].strike` (push down)
- `Signal.expiry` → `SignalLeg[].expiry` (push down)
- `Signal.direction` → removed (captured by `legs[].side`)
- `Signal.action` values: `CLOSE` → `EXIT`, `ADD` → `OPEN`, `LEG_OFF` → `TRIM`
- `Signal.exitPercent` → `Signal.exitFraction`
- `Signal.targetStrategy` → removed (orchestrator detail, not trader intent)
- `StrategySchema`: add `STRANGLE`, `CALENDAR`
- Existing labels: script to reshape (flatten inner arrays, migrate fields to legs)

## The comparison

### What we compare

```
evalLabels.signals:      Signal[]   ← ground truth (human-verified)
messageIntents.signals:  Signal[]   ← system output (LLM classification)
```

Join on `messageId`. Both are `Signal[]`. The comparison logic in `src/eval/eval.ts` works directly.

### Level 1: Trade / No-Trade

| | Label says trade | Label says no trade |
|---|---|---|
| **System says trade** | True Positive (TP) | False Positive (FP) |
| **System says skip** | False Negative (FN) | True Negative (TN) |

- **Label side:** `evalLabels.label.isTrade`
- **System side:** `messageIntents.decision = 'EXECUTE'` → trade; `'SKIP'` → no trade

Derive: precision, recall, F1, accuracy.

### Level 2: Signal-field accuracy (TP messages only)

For messages where both sides agree "this is a trade," compare signal fields using the must-match / informational split defined in the Signal redesign section above.

Also compare `signalCount` — number of signals in the message. A label with 2 signals vs system producing 1 is a structural mismatch.

## Ensuring every message has a classification

Today the deterministic path writes `decision` + `reasoning` to `message_intents` but **no signals**. The LLM path writes `Signal[]`. For comparison to work, every message needs `Signal[]` in `message_intents`.

### Path forward

Every message goes through the LLM. The LLM produces `Signal[]` via `submit_decision`. This gets written to `message_intents.signals`. Done.

Deterministic shortcuts (hard-skip, parser-based routing) are optimizations that can be introduced later — **only when measured accuracy proves they match the LLM**. When they are introduced:
- They must also produce `Signal[]` and write it to `message_intents`
- Their accuracy is measured against the same labels
- If accuracy drops, they get rolled back

This is the opposite of today's approach, where deterministic paths were introduced first and assumed correct.

## Coverage

```
coverage = labeled_messages / total_messages
```

Always display prominently. 95% accuracy on 50 labeled messages out of 2000 is meaningless.

### Labeling priority

When deciding what to label next:
1. **System classified as trade, no label** — highest priority. We're acting on this with no ground truth.
2. **System skipped with reasoning, no label** — medium. The LLM made a judgment call.
3. **Obvious skips (no badges, no symbols), no label** — lowest. These are almost certainly correct.

## Statistics

### Top-line (always visible)

| Metric | What it tells you |
|---|---|
| Coverage | How much of the dataset we can evaluate |
| Accuracy | Overall correctness |
| Precision | When we trade, how often are we right? |
| Recall | Of all real trades, how many did we catch? |
| F1 | Balanced measure |
| Signal accuracy | Among TPs, are the details right? |

### Breakdowns

**By trader.** Some traders' messages are harder to parse. This identifies which traders need more labels or cause the most errors.

**By strategy.** CDS, PDS, CALL, PUT, STOCK, STRANGLE. Shows where the classifier struggles structurally.

**By action.** OPEN vs CLOSE vs TRIM vs ADD vs LEG_OFF. Close messages are often ambiguous.

## Drill-down

**Confusion matrix → message list.** Click a cell (e.g., "FP: 7") to see those messages. Each row shows: message text, label summary, system classification, diff.

**Breakdown row → scoped view.** Click "Pete" → Pete's confusion matrix and his discrepancies.

**Message-level detail.** Split pane: label on left, system output on right, field-level diff below. Keyboard nav to scan through mismatches.

## Comparing two runs

When comparing model A vs model B, labels are the fixed baseline.

| Metric | Run A | Run B | Δ |
|---|---|---|---|
| Accuracy | 87% | 91% | +4% |
| Precision | 92% | 94% | +2% |
| Recall | 81% | 88% | +7% |

Plus a **decision diff** table: only messages where the runs disagreed. This is the highest-value view for iteration.

## Mistakes to avoid

- **Comparing against unverified labels.** Agent-generated labels that haven't been human-reviewed are themselves predictions. Comparing prediction against prediction is circular.
- **Counting unlabeled skips as correct.** A system that skips everything would score well. Always exclude unlabeled messages from accuracy stats.
- **Ignoring coverage.** Always pair accuracy with coverage.
- **Introducing deterministic shortcuts without measured accuracy.** Every shortcut must prove it matches the LLM on the labeled dataset before it replaces the LLM path.
- **Averaging signal accuracy across TP and TN.** Signal-field comparison only makes sense for TP messages. TN messages have no signals to compare.
