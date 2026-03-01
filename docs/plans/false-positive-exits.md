# Fix EXIT_VERB_RE False Positives

## Context

Backtest `b2de6318` showed message 464204 — sarcastic commentary by Hariseldon ("AAPL could announce they are **closing down** due to economic reasons...") — being parsed as action=CLOSE. The soft verb path (parser.ts:774) matched "closing" via `EXIT_VERB_RE`, and since AAPL symbol was extracted from the `<a>` tag, it set action=CLOSE and routed deterministically to position-path, which matched it to the open AAPL trade. Result: false trade, -$575 PnL.

Two more false positives from the same run share the same root cause (EXIT_VERB_RE matching non-trade uses of "close/closing"):
- msg 464911: "**Close to** yesterday's high" (proximity)
- msg 467976: "MSFT to **drop into the close**" (market close = end of day)

A fourth false positive (msg 468691: "**If** I don't get the bounce I will exit /ES") is a different class — conditional future intent. That requires a separate fix (conditional-intent detection or LLM routing) and is out of scope here.

## Changes

### 1. Parser fix — `src/intents/orchestrator/parser.ts`

Add a false-positive filter regex after `EXIT_VERB_RE` (line 75):

```ts
const EXIT_VERB_FALSE_POSITIVE_RE =
  /\bclosing\s+down\b|\bclose\s+to\b|\b(?:into|near|before|after|towards?)\s+the\s+close\b/i;
```

Gate the soft verb detection at line 774:

```ts
// Before:
if (EXIT_VERB_RE.test(cleanText) && symbol !== null) {

// After:
if (EXIT_VERB_RE.test(cleanText) && !EXIT_VERB_FALSE_POSITIVE_RE.test(cleanText) && symbol !== null) {
```

**Effect**: Messages containing these phrases skip the soft close path. With action=null and symbol present, they route to the LLM path which correctly identifies them as commentary. Badge-based exits (Exit badge, line 756-768) are unaffected — those don't go through line 774.

### 2. Eval fixtures — `src/intents/evals/fixtures/false-positive-exits.json`

New fixture file with 3 cases from the real backtest, all expecting `outcome: SKIP`:

| ID | Pattern | Message excerpt |
|---|---|---|
| `fp-exit-001` | "closing down" (business) | "AAPL could announce they are closing down..." |
| `fp-exit-002` | "close to" (proximity) | "Close to yesterday's high - also OSCR..." |
| `fp-exit-003` | "into the close" (market) | "Now I just need MSFT to drop into the close" |

Use actual `rawHtml` from the messages table. Tag: `false-positive-exit`.

### 3. Guard: also check at badge path? — No

The badge path (Exit badge -> CLOSE) at line 756-768 doesn't need this filter because the Exit badge is a strong signal placed intentionally by the platform. The false positive only arises in the **no-badge soft verb path** (line 772+).

## Files to modify

- `src/intents/orchestrator/parser.ts` — add regex + gate condition
- `src/intents/evals/fixtures/false-positive-exits.json` — new fixture file (3 cases)

## Verification

```bash
# Run all evals — confirm no regressions in existing exit cases
npx tsx scripts/eval-orchestrator.ts

# Run only new fixture
npx tsx scripts/eval-orchestrator.ts --tag false-positive-exit

# Run exits tag to confirm legitimate exits still pass
npx tsx scripts/eval-orchestrator.ts --tag exits
```
