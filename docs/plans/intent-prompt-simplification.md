# Intent Prompt Simplification: "Dumb LLM / Smart Pipeline"

## Context

External review of `INTENT_SYSTEM_PROMPT` identified three places where the LLM is forced to do math or apply strict financial logic — tasks better suited to deterministic TypeScript. The premise: make the LLM a "Text Parser" instead of a "Financial Analyst", reducing error rate and token usage.

Three proposals were evaluated by two independent investigators against 23,573 real messages and 10,560 extracted intents from the production database.

---

## The Three Proposals

### Proposal 1: Strip Calendar Math from LLM

**Current prompt instruction:**
> Always output expiry as YYYY-MM-DD... convert them. For MM/DD without a year, use the next occurrence of that date on or after the message date. A bare month name like "Oct" with no day means the standard monthly expiry (3rd Friday of that month). When a date appears as "Oct (10)", the number in parentheses is the day (October 10th), not a contract count.

**Proposed change:** Tell the LLM to extract the exact text the trader used for expiry (e.g., "next Friday", "Oct (10)", "12/19"). Do not format or do calendar math. Pass the raw string to TypeScript `normalizeExpiry(rawString, messageDate)`.

**Rationale:** LLMs are notoriously bad at calendar math. If a September 2025 message says "Next Friday", the LLM must figure out what day of the week September started on, add days, and format it — wasting reasoning tokens and inviting hallucinations (like the `"TBD"` errors we've seen).

### Proposal 2: Remove Quote Validation from LLM

**Current prompt instruction:**
> VALIDATE: Check the prefetched stock quotes in the message context. If the price seems wildly inconsistent with the trader's message, flag for review.

**Proposed change:** Remove the VALIDATE step from the LLM entirely. Don't pass quotes into the prompt (saving input tokens). Let TypeScript do a simple deterministic check: `if (Math.abs(statedPremium - quote.last) / quote.last > 0.15) { triggerManualReview(); }`.

**Rationale:** "Wildly inconsistent" is subjective. Asking an LLM to compare a stated premium against a bid/ask requires mental arithmetic and deciding if the delta crosses an arbitrary threshold.

### Proposal 3: Remove Options Leg Assembly from LLM

**Current prompt instruction:**
> PCS (Put Credit Spread): SELL the spread for credit. Map to direction: SHORT, strategy: PDS. Legs reversed from long PDS: SELL higher strike put, BUY lower strike put.

**Proposed change:** Let the LLM extract raw components: `raw_strategy: "PCS"`, `strikes: [68, 67]`. TypeScript sees "PCS", knows it means a Credit Spread, sets `direction = SHORT` and `strategy = PDS`, sorts strikes, and builds the SELL/BUY legs.

**Rationale:** Teaching the LLM spread mechanics forces it to actively remember leg reversal rules. If confused, it constructs an invalid spread.

---

## Investigation Methodology

Two investigator agents queried the production database (`trade-follower.db`) independently:

- **Investigator A**: Looked for evidence of current successes and failures across all three tasks.
- **Investigator B**: Played devil's advocate, looking for reasons the proposals could fail and finding counter-examples.

Dataset: 23,573 messages, 10,560 intents (7,886 EXECUTE / 2,440 SKIP / 234 MANUAL_REVIEW). 735 intents with expiry in signals. 135+ PCS trades examined.

---

## Findings

### Proposal 1: Calendar Math — APPROVED

**Verdict: YES, move to TypeScript (with caveats)**

#### Evidence FOR

The LLM **already fails to normalize dates 33.6% of the time**. Despite the prompt saying "Always output expiry as YYYY-MM-DD", real signal expiry values include:

| Format | Example | Frequency |
|--------|---------|-----------|
| `YYYY-MM-DD` (correct) | `2025-11-21` | 66.4% |
| `MM/DD` (no year) | `12/19`, `9/5` | Common |
| `MM/DD/YYYY` | `12/19/2025` | Occasional |
| `MonDD` | `Nov21`, `12Dec`, `19Sept` | Occasional |
| `Mon DDth` | `Dec 19th` | Rare |
| `DDMonYY` | `21Nov25` | Rare |
| `dec(N)` | `dec(5)` | Rare |
| `this Friday` | Literal relative date | Rare |
| `TBD` / `unknown` | LLM gave up | Rare |

Specific failures:
- `"Long IBM via Dec 19th 305c for 8.70"` → expiry: `"Dec 19th"` (not normalized)
- `"Long TSM add to 295/300c cds 1.98"` → expiry: `"dec(5)"` (bizarre format)
- `"Sold the $255 Covered Calls on AAPL for $1.03"` → expiry: `"unknown"` (gave up)
- `"Short AVGO using $332.5 Puts Lottos"` → expiry: `"TBD"` (gave up)

**The system already works because `normalizeExpiry()` in `occ-symbology.ts` catches all of these formats downstream.** The prompt instructions for calendar math burn tokens for a task the LLM does unreliably.

#### Caveats (from devil's advocate)

`normalizeExpiry()` does NOT currently handle these relative expressions that the LLM resolves correctly today:

| Expression | Example | LLM got it right |
|------------|---------|-------------------|
| `"tomorrow"` | `"Short SPY using tomorrow's $665 Puts"` → `2025-09-17` | Yes |
| `"next week"` | `"Long EOSE $17.5C/19.5C $0.89 next week"` → `2025-11-14` | Yes |
| `"1DTE"` | `"Short WDC bought 1DTE $125 puts"` → `2025-10-17` | Yes |

These would need to be added to `normalizeExpiry()`.

**Semantic disambiguation still requires the LLM**: In `"Short ALAB 170p 12/19 at 29.30... won't be surprised if we see a day of rest tomorrow"`, the LLM correctly uses `12/19` as expiry and ignores "tomorrow" (commentary). A naive extractor that grabs all date-like tokens would fail. The LLM keeps the job of identifying WHICH token is the expiry.

#### Implementation

1. Change prompt: "Extract the exact text the trader used for the expiration date (e.g., 'next Friday', 'Oct (10)', '12/19'). Do not format it. If no date is stated, output `null`."
2. Extend `normalizeExpiry()` to handle `"tomorrow"`, `"next week"`, `"1DTE"`, `"this week"`.
3. The LLM retains semantic disambiguation (picking the right date token from context).

---

### Proposal 2: Quote Validation — REJECTED

**Verdict: NO, keep quotes in prompt**

#### Evidence AGAINST removal

The proposal's premise is wrong. It assumes quote validation is expensive LLM work. In reality:

**Quotes are already prefetched by TypeScript** (`prefetchQuotes` in `extract-intent.ts:544-568`). They're injected as ~2 lines of text in the user prompt:
```
Quotes:
  ORCL: bid=243.1 ask=243.39 last=243.245
```

The LLM isn't doing expensive fetching — it reads numbers already in context. The `get_quote` tool is actively called in only 7.3% of intents.

**Quotes serve double duty beyond validation:**

1. **Typo detection**: `MU $12.82` vs market `$122.85` (decimal point error) — correctly caught and flagged MANUAL_REVIEW.
2. **Strategy disambiguation**: `IONQ $6340` recognized as typo for `$63.40` via quote context — LLM proceeded with EXECUTE instead of flagging.
3. **Legitimate MANUAL_REVIEW triggers**: 13+ real cases where price discrepancy correctly flagged human review.

**Trigger rate is low but catches are high-value**: VALIDATE appears in 77% of intent reasoning but only changes the outcome 0.3% of the time. However, those 0.3% catches are genuine typos and errors worth catching.

**Backtest false positive concern**: Some MANUAL_REVIEW flags were false positives in backtest context (current quote differs from historical message time). This is a backtest-specific issue, not a reason to remove validation from live.

#### Possible compromise

Remove the explicit `VALIDATE` step label from the prompt. The LLM will still naturally reason about prices if it sees them in context. Optionally add a TypeScript post-extraction guard for the mechanical `>15% threshold → MANUAL_REVIEW` check. But do NOT remove quote context from the prompt.

---

### Proposal 3: Leg Assembly — REJECTED

**Verdict: NO, keep in prompt**

#### Evidence AGAINST removal

**100% accuracy on leg assembly.** Across 135+ PCS trades examined, zero PCS→PDS mapping errors. Zero leg construction errors on any spread type (PCS, CDS, PDS):

| Message | LLM Output | Correct? |
|---------|-----------|----------|
| `"Long IREN PCS (40/35)"` | SELL 40P / BUY 35P | Yes |
| `"Long SHOP 145/144 PCS"` | SELL 145P / BUY 144P | Yes |
| `"Long RDDT 235/240c cds"` | BUY 235C / SELL 240C | Yes |
| `"Short TSLA PDS $445/$440"` | BUY 445P / SELL 440P | Yes |

**The LLM handles all regular patterns flawlessly.** Real messages follow highly regular formats (`"Long [SYM] [strikes] [strategy] for [price]"`).

#### Critical counter-evidence: Implicit strategy inference

~20+ real messages have NO explicit strategy — the LLM infers CDS/PDS from trader profile and context:

| Message | LLM Inference | Why TS can't do this |
|---------|--------------|---------------------|
| `"Long CRWV again"` | CDS 135/140C | No strategy stated. Inferred from trader profile + prior CRWV CDS trades. |
| `"Long UNH"` (2 words) | CDS 355/365C | Inferred from trader's known strategy list (CDS, PDS, CALL, PUT). |
| `"Bought back the short Calls on META"` | LEG_OFF from CDS | "Short Calls" implies they were part of a spread. |
| `"Long back in TSLA tight leash under this candle"` | CDS 445/455C | No strategy, no strikes. Full inference from context. |

A `raw_strategy + strikes[]` schema fails here because there IS no raw strategy to extract. The LLM must use financial knowledge + trader context to determine the spread type.

#### Schema impact

Changing from structured `SignalLegSchema` (with `strike`, `expiry`, `optionType`, `action`) to raw `strikes[]` would require a dual-path schema (explicit vs. inferred), touching `SignalSchema`, `buildOptionLegs()`, `resolveSignalLegs()`, `buildOrderFromSignal()`, and every consumer of `Signal.legs`. This adds complexity to a system with zero errors.

#### Minor issue already mitigated

The LLM occasionally emits duplicate legs (e.g., `[SELL 180P, SELL 180P]` for a naked put). This is already handled by dedup logic in `buildOptionLegs()` at `execute.ts:148-158`.

---

## Summary

| Proposal | Verdict | Risk | Benefit | Action |
|----------|---------|------|---------|--------|
| 1. Calendar Math | **APPROVED** | Low-Medium | Medium | Strip YYYY-MM-DD formatting from prompt. LLM extracts raw text. Extend `normalizeExpiry()`. |
| 2. Quote Validation | **REJECTED** | High | Low | Keep quotes in prompt. Optionally remove `VALIDATE` step label, add TS post-extraction threshold check. |
| 3. Leg Assembly | **REJECTED** | High | None | Keep in prompt. 100% accuracy, handles implicit inference TS can't replicate. |

The outside advice was 1 for 3. The strongest proposal (calendar math) is genuinely backed by data — the LLM fails at it frequently and TypeScript already compensates. The other two proposals solve problems that don't exist in the real data: the LLM reads cheap prefetched quotes naturally, and it assembles spread legs with perfect accuracy including cases where financial inference is required.
