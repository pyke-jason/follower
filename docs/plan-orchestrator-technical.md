# Intent Orchestrator — Technical Plan

The tactical decomposition of the north star architecture in `plan-prompt-simplification.md`.

---

## Current State

The pipeline today is: deterministic skip → optional strangle preprocess → LLM → postprocess.

```
message → skip checks → stranglePreprocess? → LLM (always) → postprocess → signal
```

Postprocessors (leapExpiryFix, lottoDirectionFix, soldWroteDirectionFix, expiryHintInjection)
patch LLM output after the fact. The LLM runs on every non-skipped message, even when the
message is unambiguous ("Long AAPL 180/185 cds for $2.10").

Signals can exit with hint legs (strike=0) that get resolved downstream in `signal-legs.ts`.
This means the signal contract is leaky — execution must handle partial resolution.

**Key files today:**
- `src/intents/extract-intent.ts` — entry point, LLM orchestration, cache
- `src/intents/prompts.ts` — prompt templates (~6000 tokens)
- `src/intents/versions.ts` — pipeline version registry (prompt + pre/postprocessors)
- `src/intents/postprocess.ts` — post-LLM signal fixes
- `src/pipeline/execute.ts` — signal execution, leg resolution, order placement
- `src/pipeline/signal-legs.ts` — hint leg → real leg resolution
- `src/lib/spread-legs.ts` — strategy+direction → leg actions
- `src/agent/schemas.ts` — Signal, SignalLeg types

---

## Target State

```
message → orchestrator.resolve(context) → ResolvedSignal[] | SKIP | FLAG_FOR_REVIEW
```

The orchestrator replaces the current skip→LLM→postprocess chain with a field-by-field
resolution engine. Each field resolves independently to a concrete value, or the message
is flagged.

No hint legs. No downstream resolution. `signal-legs.ts` goes away or becomes an internal
detail of the orchestrator. The execution pipeline receives complete signals only.

---

## The Output Contract

The orchestrator's output is as minimal as possible. A `ResolvedSignal` is a broker
instruction: what to trade, how to package the order, and what limit to use.

```typescript
type ResolvedSignal = {
  orderType: 'SINGLE' | 'SPREAD' | 'STOCK';
  legs: Leg[];
  limitPrice?: number;        // positive = debit (paying), negative = credit (receiving)
};

type Leg =
  | {
      type: 'option';
      symbol: string;           // underlying, e.g., "AAPL"
      expiry: string;           // YYYY-MM-DD
      optionType: 'CALL' | 'PUT';
      strike: number;
      side: 'BUY' | 'SELL';
      quantity: number;         // ratio per lot (1 = standard, 2 = ratio spread)
    }
  | {
      type: 'stock';
      symbol: string;
      side: 'BUY' | 'SELL';
      quantity: number;         // ratio per lot
    };
```

**Design decisions:**

- **No `symbol` on the signal** — derivable from the legs. The underlying is on each leg.
- **No `action`** (OPEN/CLOSE/TRIM/LEG_OFF) — that's orchestrator routing logic. By the time
  a signal exits, it's just "execute these legs." A CLOSE is `SELL 1 AAPL 260307C00180000`.
  A TRIM of half (10 contracts → 5) is `SELL 5 AAPL 260307C00180000`. A LEG_OFF is
  `BUY 1 AAPL 260307C00185000` (buying back the short leg).
- **No `strategy`** — the broker doesn't care if it's a CDS or PDS. It just sees "spread order,
  these legs, this net limit." Strategy is the orchestrator's internal reasoning.
- **No `direction`** — derivable from the legs. Net BUY = long, net SELL = short.
- **No OCC symbol** — OCC is a serialization format for the broker adapter. The orchestrator
  works with `(symbol, expiry, strike, optionType)` — human-readable, easy to validate.
- **`orderType`** — tells the execution pipeline how to package for the broker. `SPREAD` = one
  multi-leg order with a net limit. `SINGLE` = one option leg. `STOCK` = equity order.
- **`quantity` is a ratio** — normalized per-lot (1 = standard, 2 = ratio spread). The execution
  pipeline multiplies by the sized lot count. The orchestrator doesn't know position sizing.
- **`limitPrice` is signed** — positive means debit (you pay), negative means credit (you receive).
  A CDS at $2.10 → `limitPrice: 2.10`. A PDS sold for $0.63 credit → `limitPrice: -0.63`.

**Orchestrator result:**

```typescript
type OrchestratorResult =
  | { outcome: 'EXECUTE'; signals: ResolvedSignal[] }
  | { outcome: 'SKIP'; reason: string }
  | { outcome: 'FLAG_FOR_REVIEW'; reason: string; partial?: Partial<ResolvedSignal>[] };
```

---

## The DI Context

The orchestrator receives a context object with everything any code path might need:

```typescript
type OrchestratorContext = {
  // Message
  messageId: string;
  rawHtml: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
  timestamp: string;              // ISO 8601
  author: string;

  // Injected capabilities
  marketData: MarketDataProvider;  // quotes, chains, greeks
  positions: PositionProvider;     // open positions for the trader
  chatHistory: ChatHistoryProvider; // recent messages for context
  traderConfig: TraderConfig;
};
```

Same interface for live and backtest. The orchestrator doesn't know which environment it's in.

---

## Resolution: Parse → Route → Resolve

The orchestrator first parses the message text (synchronous, no I/O), then routes
to one of several distinct paths based on what was parsed.

### Parse (synchronous, no I/O)

Extract everything derivable from the message text alone:

**Text extraction** (regex / keyword):
- `badges[]` — from HTML badge encoding (already done by `htmlToLLMText`)
- `symbols[]` — ticker regex, link extraction
- `actionHint` — exit badge, "exit"/"sold"/"bought"/"wrote" verbs, fraction indicators
- `strategyHint` — "cds", "pds", "pcs", "puts", "calls", "stock", "strangle", "lotto"
- `strikes[]` — numbers adjacent to strategy keywords
- `expiryHint` — date patterns, "next week", "Oct", "LEAP", "0DTE"
- `premiumHint` — dollar amounts ("$2.10", ".63 credit")
- `fractionHint` — "1/2", "half", "third"

**Deterministic rules**:
- Direction: strategy-deterministic (CDS→LONG, PCS→{PDS,SHORT}), verb overrides
  (lotto→LONG, wrote→SHORT, sold→SHORT)
- Strategy: PCS → normalize to PDS
- Complexity detection: extra text beyond parsed fields, multiple tickers, relational
  language, mixed entry+exit

**Output**: a `ParseResult` with concrete values for what's known and `null` for what
isn't, plus complexity flags.

```typescript
type ParseResult = {
  action: Action | null;
  symbol: string | null;
  direction: Direction | null;
  strategy: Strategy | null;
  strikes: number[] | null;
  expiryHint: string | null;       // raw text, not yet resolved to date
  premiumHint: number | null;
  exitPercent: number | null;
  targetStrategy: Strategy | null;
  complexityFlags: Set<'extra_text' | 'multi_ticker' | 'relational' | 'mixed_action'>;
};
```

`ParseResult` is an internal orchestrator type — it does NOT appear in the output.
It determines which route the message takes.

### Route: Open Path

**Condition**: action=OPEN, no complexity flags, all core fields parsed.

This path never touches `PositionProvider`. It needs `MarketDataProvider` to concretize
strikes and expiry, then builds the final `ResolvedSignal`.

**Expiry resolution** (ordered by specificity):
1. Explicit date in text → parse to YYYY-MM-DD
2. "LEAP" → message date + 1 year, find nearest listed expiry
3. "0DTE" / lotto → message date, confirm options exist
4. "next week" / relative → date math from message timestamp
5. Named month ("Oct") → third Friday of that month
6. No expiry + premium stated → scan this-week, next-week, monthly for mid ≈ premium
7. No expiry + no premium → default nearest weekly (configurable per strategy)

**Strike resolution** (when strikes not in text):
1. Delta-based (lotto): scan chain for target delta on resolved expiry
2. ATM inference: stock quote → nearest listed strike
3. Premium-inferred: stated premium + chain quotes → which strike matches

**Premium validation** (when premium is stated):
- Fetch mid for resolved legs
- Within tolerance → proceed
- Way off → FLAG_FOR_REVIEW (stale message, wrong contract, etc.)

**Build final signal**: assemble `ResolvedSignal` from resolved fields.
- Determine `orderType`: 2+ legs → SPREAD, 1 option leg → SINGLE, stock → STOCK.
- Compute `limitPrice` from stated premium (signed: debit positive, credit negative).
- Set leg `quantity` as normalized ratio (typically 1 per leg; 2 for ratio spreads).

If any field can't be resolved → FLAG_FOR_REVIEW with the partial parse. Don't guess.

### Route: Position Path (Close / Trim / Leg-off)

**Condition**: action is CLOSE, TRIM, or LEG_OFF (identified from exit badge, fraction,
or verb).

This is a fundamentally different path from opens. The signal is derived from the
trader's *existing position*, not from the message text. The message tells us *what*
to do (close, trim half, leg off the short side); the position tells us *which contracts*.

**Steps**:
1. Look up trader's open positions via `PositionProvider` (filter by symbol, optionally
   strategy hint from message — "calls" / "puts" / "cds").
2. Fuzzy match if needed: drop strategy filter when only 1 position on that symbol.
3. For CLOSE: reverse all legs of the matched position.
4. For TRIM: compute quantity from exitPercent (e.g., 50% of 10 = 5), reverse legs.
5. For LEG_OFF: identify which leg to close (from "hold straight calls" → close the
   SELL leg, keep the BUY), reverse that leg only.
6. Build `ResolvedSignal` with concrete legs from the position.

This path uses `PositionProvider` but typically not `MarketDataProvider` — the contracts
are already known from the existing position. It may need `ChatHistoryProvider` if the
LLM is involved (casual exit language like "took profits on CRWV calls").

**When the LLM is needed on this path**: if the parse can't determine the action
(no exit badge, casual language), the message routes to the LLM first, which identifies
the action and target. Then the result feeds into this path for position lookup and
leg reversal.

### Route: LLM Path

**Condition**: complexity flags fired, or action couldn't be determined from parse.

This is the fallback for messages that need natural language understanding:
- Casual exit language ("took profits on CRWV calls this morning")
- Follow / relational trades ("following Dave on MSTR")
- Multi-trade decomposition (two trades in one message)
- Leg-off instructions ("exit the spread, hold straight calls")
- Ambiguous action classification

The LLM receives:
- The original message (with badge encoding)
- Whatever the parse resolved (as structured context)
- Relevant chat history via `ChatHistoryProvider`
- Tools: `submit_decision`, `flag_for_review`, `get_recent_chat`

Direction rules, PCS normalization, lotto/wrote overrides, and badge interpretation
are gone from the prompt — they're handled in the parse step.

LLM output still gets safety-net postprocessors (lottoDirectionFix, soldWroteDirectionFix)
because the model can still get these wrong.

After the LLM produces its interpretation, each resulting signal routes back into either
the **Open Path** (for new positions — needs market data concretization) or the
**Position Path** (for closes/trims — needs position lookup). The LLM is never expected
to produce concrete expiry dates, resolved strikes, or signed limit prices.

### Route: Skip / Flag

**Condition**: hard skip (paper trade, futures, both Long+Short badges without strangle
keyword) or unresolvable parse.

Exits immediately. No I/O, no LLM.

---

## Strike Selection as a First-Class Concept

The signal schema today has `legs: SignalLeg[]` where `strike: 0` means "resolve later."
This is implicit and brittle. The orchestrator instead uses explicit selection strategies
as an internal concept (not exposed in the output):

```typescript
type StrikeSelection =
  | { method: 'explicit'; strikes: number[] }
  | { method: 'delta'; target: number; direction: 'nearest' | 'otm' | 'itm' }
  | { method: 'atm' }
  | { method: 'premium_match'; statedPremium: number };
```

Phase 1 determines the selection method. Phase 2 executes it against market data.
Adding new methods (e.g., "25-delta call", "cheapest OTM under $0.50") is a new
variant, not a restructuring.

---

## Code Path Examples

### "Long AAPL 180/185 cds for $2.10" → Open Path
```
Parse:  action=OPEN, symbol=AAPL, strategy=CDS, direction=LONG,
        strikes=[180,185], premium=2.10, expiryHint=null. No complexity flags.
Route:  Open Path.
        Strikes explicit. No expiry → premium match.
        Scan this-week 180/185 CDS mid vs $2.10, next-week mid vs $2.10.
        This-week mid=$2.05 (within 5%) → expiry=2026-03-07.
        spreadLegs(CDS, LONG, 180, 185) → BUY 180C, SELL 185C.
→ { orderType: 'SPREAD',
    legs: [
      { type: 'option', symbol: 'AAPL', expiry: '2026-03-07', optionType: 'CALL', strike: 180, side: 'BUY', quantity: 1 },
      { type: 'option', symbol: 'AAPL', expiry: '2026-03-07', optionType: 'CALL', strike: 185, side: 'SELL', quantity: 1 },
    ],
    limitPrice: 2.10 }
```

### "Short NVDA Lotto puts" → Open Path (delta-based strikes)
```
Parse:  action=OPEN, symbol=NVDA, strategy=PUT, direction=LONG (lotto override),
        strikes=null, expiryHint="0DTE" (lotto context), premium=null.
        Strike selection: { method: 'delta', target: 0.7 }. No complexity flags.
Route:  Open Path.
        Expiry=today (2026-02-24). Fetch NVDA option chain for today's expiry.
        Find put with delta nearest 0.7 → strike=850.
→ { orderType: 'SINGLE',
    legs: [
      { type: 'option', symbol: 'NVDA', expiry: '2026-02-24', optionType: 'PUT', strike: 850, side: 'BUY', quantity: 1 },
    ] }
```

### "Long UNH cds for next week expiration" → Open Path (ATM inference)
```
Parse:  action=OPEN, symbol=UNH, strategy=CDS, direction=LONG,
        strikes=null, expiryHint="next week", premium=null.
        Strike selection: { method: 'atm' }. No complexity flags.
Route:  Open Path.
        Expiry="next week" → 2026-03-06.
        Fetch UNH quote → $510. ATM strikes → 510/515 CDS.
→ { orderType: 'SPREAD',
    legs: [
      { type: 'option', symbol: 'UNH', expiry: '2026-03-06', optionType: 'CALL', strike: 510, side: 'BUY', quantity: 1 },
      { type: 'option', symbol: 'UNH', expiry: '2026-03-06', optionType: 'CALL', strike: 515, side: 'SELL', quantity: 1 },
    ] }
```

### "Exit RKLB 1/2" → Position Path (trim)
```
Parse:  exit badge, ticker RKLB, fraction "1/2" → action=TRIM, exitPercent=0.5.
Route:  Position Path.
        Look up open RKLB position → 10x RKLB 260307C00030000 (BUY side).
        50% of 10 = 5. Reverse side → SELL.
→ { orderType: 'SINGLE',
    legs: [
      { type: 'option', symbol: 'RKLB', expiry: '2026-03-07', optionType: 'CALL', strike: 30, side: 'SELL', quantity: 5 },
    ] }
```

### "Exit Long UNH cds took small profit hold straight calls" → Position Path (leg-off)
```
Parse:  exit badge, ticker UNH, "cds" present. "hold straight calls" is NLU →
        can't distinguish CLOSE from LEG_OFF deterministically.
Route:  LLM Path → identifies LEG_OFF, targetStrategy=CALL.
        Feeds into Position Path.
        Look up open UNH CDS position → [BUY 510C, SELL 515C], 10 contracts each.
        LEG_OFF keeping calls → close the SELL leg.
→ { orderType: 'SINGLE',
    legs: [
      { type: 'option', symbol: 'UNH', expiry: '2026-03-06', optionType: 'CALL', strike: 515, side: 'BUY', quantity: 10 },
    ] }
```

### "Took profits on CRWV calls this morning" → LLM Path → Position Path
```
Parse:  action=null (no badge, "took profits" is NLU). Can't determine action.
Route:  LLM Path.
        LLM identifies: CLOSE CRWV, strategy hint CALL.
        Feeds into Position Path.
        Look up open CRWV CALL position → 10x CRWV 260307C00025000 (BUY side).
        Reverse all legs → SELL.
→ { orderType: 'SINGLE',
    legs: [
      { type: 'option', symbol: 'CRWV', expiry: '2026-03-07', optionType: 'CALL', strike: 25, side: 'SELL', quantity: 10 },
    ] }
```

### "following Dave on MSTR" → LLM Path → Open Path
```
Parse:  no badge, no structured fields. "Following Dave" = relational language.
Route:  LLM Path.
        LLM calls get_recent_chat, finds Dave's recent MSTR trade (OPEN LONG CDS
        MSTR 180/185 for $3.20).
        Feeds into Open Path for concretization.
        Premium match → expiry resolved, legs built.
→ { orderType: 'SPREAD', legs: [...], limitPrice: 3.20 }
```

### "Long AAPL 180/185 cds for $2.10 but also adding more to SPY from yesterday" → LLM Path → both
```
Parse:  action=OPEN, symbol=AAPL, strategy=CDS, strikes=[180,185], premium=2.10.
        Complexity flags: { extra_text, multi_ticker, relational }.
Route:  LLM Path.
        LLM decomposes into two intents: AAPL CDS 180/185 + SPY add from yesterday.
        AAPL intent feeds into Open Path → concretize expiry via premium match.
        SPY intent feeds into Position Path → look up existing SPY position, build add.
→ [
    { orderType: 'SPREAD', legs: [AAPL 180C BUY, AAPL 185C SELL], limitPrice: 2.10 },
    { orderType: '...', legs: [SPY ...], limitPrice: ... },
  ]
```

### "Long GLW pcs 68/67 for .63 credit" — premium mismatch → Open Path → Flag
```
Parse:  action=OPEN, symbol=GLW, strategy=PDS (PCS normalized), direction=SHORT,
        strikes=[68,67], premium=0.63. No complexity flags.
Route:  Open Path.
        No expiry stated → premium match.
        This-week 68/67 PDS mid=$0.15. Next-week=$0.22. Monthly=$0.31.
        None within 5% of $0.63.
→ FLAG_FOR_REVIEW: premium mismatch, no expiry matches stated $0.63
```

---

## Migration Path

This doesn't need to be built all at once. The phases can be introduced incrementally:

**Step 1**: Extract Phase 1 parser from the existing postprocessors and skip logic.
Today's postprocessors already contain the rules (lotto→LONG, PCS→PDS, etc.) — they
just run after the LLM instead of before it. Lift them into a standalone parse function
that runs first and produces a `ParseResult`.

**Step 2**: For messages where Phase 1 resolves everything and no complexity flags fire,
bypass the LLM entirely. This is the "deterministic fast path." Run the existing eval
suite to confirm no regressions.

**Step 3**: Build Phase 2 market data resolution. Start with premium-to-expiry matching
(highest value — eliminates the most common hint leg). Then ATM inference. Then delta-based.

**Step 4**: Simplify the LLM prompt. Remove all rules that Phase 1 now handles. The prompt
shrinks, the model focuses on NLU, accuracy on hard cases improves.

**Step 5**: Tighten the signal contract. Remove hint legs from the schema. `signal-legs.ts`
resolution logic moves into the orchestrator. Execution pipeline receives only
`ResolvedSignal` (concrete legs, signed limit, order type).

Each step is independently deployable and testable against the eval suite + full message
history.

---

## What Changes in Existing Code

| Current | Target | Notes |
|---------|--------|-------|
| `postprocess.ts` (lottoFix, wroteFix, etc.) | Phase 1 rules | Same logic, runs before LLM not after |
| `signal-legs.ts` (resolveSignalLegs) | Phase 2 market resolution | Same logic, runs inside orchestrator |
| `extract-intent.ts` (runIntentPipeline) | Orchestrator entry point | Replaces skip→LLM→postprocess chain |
| `prompts.ts` (6000-token prompt) | Slimmed prompt for NLU-only cases | Drops direction/PCS/badge rules |
| `versions.ts` (pipeline versions) | Orchestrator config | Phase 1 rules + Phase 2 config + Phase 3 prompt |
| `execute.ts` (hint leg handling) | Removed | Signals arrive as `ResolvedSignal` |
| `schemas.ts` (SignalLeg with strike=0) | `Leg` discriminated union | No more hint legs. Option vs stock. |

---

## Composability Requirement

Every rule, resolution strategy, and default is a swappable unit. The orchestrator is
a composition of small, independent functions — not a monolith. Adding a new strike
selection method, changing a default expiry, or adjusting a tolerance should be a
one-function change, not a restructuring.

Concretely: the parse step is a chain of extractors (badge reader, ticker regex, strategy
keyword matcher, etc.). Each route is a chain of resolvers (expiry resolver, strike
resolver, premium validator, etc.). New extractors and resolvers slot in without touching
the orchestrator's routing logic.

### v0 Defaults

These are starting assumptions. Each is a single config value or function that gets
refined as we validate against real trader behavior.

| Parameter | v0 Default | Notes |
|-----------|-----------|-------|
| Lotto delta target | 0.7 | Validate against actual trader picks per message history |
| ATM rounding | Nearest listed strike | May need ITM/OTM bias per strategy or trader |
| Premium tolerance | 5% | May tighten for spreads, loosen for naked options |
| Default expiry (no hint, no premium) | Nearest weekly Friday | May vary per strategy or trader |
| Strangle decomposition | Fork into two SINGLE signals (one CALL, one PUT) | Parse step recognizes "strangle" keyword |
