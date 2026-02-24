# Intent Pipeline — North Star

## The Goal

A raw Discord message goes in. Fully-specified, unambiguous trading signals come out —
or the message is flagged for human review. There is no middle ground. Every signal
that exits the pipeline has concrete values for every field required to place an order.

"Fully specified" means:
- **Action**: OPEN, CLOSE, TRIM, LEG_OFF
- **Symbol**: resolved ticker
- **Direction**: LONG or SHORT
- **Strategy**: CALL, PUT, CDS, PDS, STOCK, STRANGLE
- **Legs**: concrete OCC contracts (real strikes, real expiry dates)
- **Stated premium**: if the trader mentioned a price

If the pipeline cannot resolve any required field to a concrete value, the message
is flagged for review. No hint legs, no "resolve later", no ambiguity pushed downstream.

---

## The Orchestrator

The orchestrator is a decision engine that runs whatever code path a given message
needs. Some messages resolve entirely through regex and rules. Some need option chain
lookups to select a strike. Some need an LLM to parse casual English. Some need all
three.

There is no fixed hierarchy of "cheap path first, then escalate." The orchestrator
examines the message, determines what's known and what's missing, and dispatches to
the appropriate resolver for each unknown field. The resolvers are:

- **Text parse** — regex extraction of tickers, strikes, premiums, expiry text,
  strategy keywords, action verbs, fractions. Fast, free.
- **Deterministic rules** — strategy-to-direction mapping, PCS normalization,
  lotto/wrote overrides, badge interpretation. Fast, free.
- **Market data** — option chain lookup for delta-based strike selection, premium-to-expiry
  matching, ATM strike inference. Costs API calls, requires live/cached data.
- **LLM** — natural language understanding for casual exit language, follow trades,
  multi-trade messages, relational context. Slow, expensive.

These are not tiers. They're tools. A single message might use text parse for the
symbol, a deterministic rule for direction, a chain lookup for strikes, and an LLM
for nothing. Another message might need the LLM for everything. The orchestrator
doesn't care how a field gets resolved, only that it does.

---

## Field Resolution

Every message needs these fields resolved:

| Field | Typical resolution | Hard cases |
|-------|-------------------|------------|
| **Action** | Badge + verb keywords | Casual language ("took profits on...") |
| **Symbol** | Regex / ticker links | "following Dave on MSTR" (relational) |
| **Strategy** | Keyword match ("cds", "puts") | Implied from context ("added more to my position") |
| **Direction** | Strategy-deterministic or verb-derived | Naked PUT with ambiguous context |
| **Strikes** | Explicit numbers in text | Lotto (delta-based selection), no strikes stated (ATM inference) |
| **Expiry** | Explicit date, relative phrase, keyword | No expiry + premium stated (infer from quote matching) |
| **Premium** | Dollar amount in text | Absent (not required, but used for validation) |

### Strike Selection Strategies

Strikes are not always literal numbers in the message. The orchestrator must support
multiple resolution methods:

- **Explicit**: "180/185 cds" — strikes are in the text
- **Delta-based**: "lotto puts" — find the put near a target delta (e.g., ~0.7) for
  today's expiry. Requires option chain + greeks.
- **ATM inference**: "UNH cds" with no strikes — use current stock price to find
  near-the-money strikes. Requires stock quote.
- **Premium-inferred**: stated premium narrows which contract the trader is in when
  strikes aren't stated. Requires option chain quotes.

The specific delta target, ATM rounding rules, and premium tolerance are configurable
parameters — not hardcoded assumptions. The architecture supports adding new selection
methods (e.g., "the 25-delta call") without restructuring.

### Expiry Resolution

Similarly, expiry is not always a date:

- **Explicit date**: "March 6", "3/6" — parse to YYYY-MM-DD
- **Relative phrase**: "next week", "next Friday" — date math from message timestamp
- **Named month**: "Oct" — resolve to standard monthly (third Friday)
- **Keyword**: "LEAP" — refDate + 1 year. "0DTE" / lotto context — today's expiry.
- **Premium-inferred**: no expiry stated + premium stated — which expiry's mid matches?
  Try this-week, next-week, monthly in order. Requires market data.
- **Unresolvable**: no expiry, no premium, no contextual hint — flag for review

---

## DI Context

The orchestrator receives a context object with everything it might need. Code paths
pull what they need from it:

- **Message data**: raw HTML, clean text, badges, symbols, timestamp, author
- **Market data provider**: stock quotes, option chains, greeks (may be live API or
  backtest cache — same interface)
- **Position state**: current open positions for the trader (for CLOSE/TRIM matching)
- **Chat history**: recent messages from all traders (for follow trades, "same as above")
- **Trader config**: who is tracked, what strategies they use, any trader-specific rules

The same DI interface serves both live trading and backtesting. The orchestrator
doesn't know or care which environment it's in.

---

## The Signal Contract

A signal exiting the orchestrator is one of:

1. **EXECUTE** — all fields resolved to concrete values. Ready for order placement.
2. **SKIP** — message is not a trade (commentary, paper trade, futures, etc.)
3. **FLAG_FOR_REVIEW** — message looks like a trade but one or more fields could not
   be resolved. Includes what was resolved and what failed, so a human can fill in
   the gaps.

There is no "partially resolved" state that flows into execution. The execution
pipeline trusts that every signal it receives is complete.

---

## What the LLM Handles

Once the orchestrator handles structured messages deterministically, the LLM only
sees what genuinely requires language understanding:

- Casual exit language ("took profits on CRWV calls this morning")
- Follow trades ("following Dave on MSTR") — needs chat history tool
- Multi-trade messages with interleaved commentary
- Relational references ("same as above", "adding to my existing")
- Leg-off instructions ("exit the spread, hold straight calls")
- Ambiguous action (is "NVDA having a great day" a trade or commentary?)

The LLM prompt can drop all the rules that exist today for structured cases it will
never see — direction rules for spreads, PCS normalization, badge confusion. It gets
shorter and focused on what the model is actually good at.

---

## Validation Layer

After a signal is produced — by any code path — a validation layer checks it against
market reality before order placement:

- **Stated premium vs current mid**: within tolerance → execute. Way off → flag.
- **Expiry still valid**: not expired, market open for that expiry
- **Contract exists**: the OCC symbol resolves to a real listed option

This layer runs uniformly on all signals. It's a safety net, not a routing decision.

---

## Example Flows

Each example shows which tools the orchestrator uses and why.

---

### 1. Fully structured entry — parse + rules + market data

**Message:** `<LONG BADGE /> AAPL 180/185 cds for $2.10`

**Parse**: ticker AAPL, strategy CDS, strikes [180, 185], premium $2.10. No expiry.
**Rules**: CDS → direction LONG. `spreadLegs(CDS, LONG, 180, 185)` → [BUY 180C, SELL 185C].
**Market data**: no expiry stated, premium $2.10 → scan this-week and next-week 180/185 CDS
mids. This-week mid $2.05 (within tolerance) → expiry = this Friday. Build OCC symbols.

**LLM**: not called.

**Signal**: OPEN LONG CDS AAPL, legs [BUY AAPL 260307C00180000, SELL AAPL 260307C00185000],
statedPremium 2.10

---

### 2. Same structure, premium mismatch — flag for review

**Message:** `<LONG BADGE /> AAPL 180/185 cds for $2.10`

**Parse + Rules**: same as above.
**Market data**: this-week mid $0.42, next-week mid $0.89. Neither matches $2.10.

**LLM**: not called.

**Result**: FLAG_FOR_REVIEW — premium mismatch, no expiry matches stated $2.10.

---

### 3. Extra text, multiple tickers — parse + LLM

**Message:** `<LONG BADGE /> AAPL 180/185 cds for $2.10 but also adding more to my SPY position from yesterday`

**Parse**: sees AAPL CDS with strikes and premium. Also detects ticker SPY and relational
language "from yesterday".
**Rules**: complexity flags fire — extra text, multi-ticker, relational language.

**LLM**: receives full message + Phase 1 partial parse as context. Confirms AAPL CDS signal,
identifies separate SPY add by resolving "from yesterday" against chat history.

**Market data**: each signal re-enters for expiry/strike concretization.

**Signals**: OPEN LONG CDS AAPL [concrete legs] + OPEN LONG SPY [concrete legs from context]

---

### 4. PCS normalization — parse + rules + market data

**Message:** `<LONG BADGE /> GLW pcs 68/67 for .63 credit`

**Parse**: ticker GLW, strategy PCS, strikes [68, 67], premium $0.63.
**Rules**: PCS → normalize to {PDS, SHORT}. `spreadLegs(PDS, SHORT, 68, 67)` → [SELL 68P, BUY 67P].
Badge says Long — ignored (strategy-deterministic direction).
**Market data**: no expiry → premium match. Scan this-week/next-week 68/67 PDS mids vs $0.63.

**LLM**: not called.

**Signal**: OPEN SHORT PDS GLW, legs [SELL GLW ...P00068000, BUY GLW ...P00067000],
statedPremium 0.63

---

### 5. Authoritative verb overrides badge — parse + rules + market data

**Message:** `<LONG BADGE /> BE sold Oct $59 put $2.40. Happy to own the stock below AVWAPE.`

**Parse**: ticker BE, strategy PUT, strike 59, expiry text "Oct", premium $2.40.
Verb "sold" detected. Trailing commentary stripped (not a trade field).
**Rules**: "sold" → direction SHORT (overrides Long badge). Expiry "Oct" → third Friday of October.
**Market data**: fetch BE 59P at October monthly. Mid $2.35 (within tolerance) → confirmed.

**LLM**: not called.

**Signal**: OPEN SHORT PUT BE, legs [SELL BE 251017P00059000], statedPremium 2.40

---

### 6. Lotto — parse + rules + market data (delta-based strike selection)

**Message:** `<SHORT BADGE /> NVDA Lotto puts`

**Parse**: ticker NVDA, strategy PUT, keyword "lotto". No strikes, no expiry, no premium.
**Rules**: "lotto" → direction LONG (overrides Short badge). Lotto context → expiry 0DTE,
strike selection method = delta-based (~0.7 target).
**Market data**: fetch NVDA option chain for today's expiry. Scan puts for delta nearest 0.7.
Find 850P at delta 0.68 → select. Build OCC symbol.

**LLM**: not called.

**Signal**: OPEN LONG PUT NVDA, legs [BUY NVDA 260224P00850000]

---

### 7. Wrote/writing — parse + rules + market data

**Message:** Wrote SPY 580 puts

**Parse**: ticker SPY, strategy PUT, strike 580. Verb "wrote".
**Rules**: "wrote" → direction SHORT. Legs: [SELL 580P].
**Market data**: no expiry → default nearest weekly. Confirm 580P exists on that expiry.

**LLM**: not called.

**Signal**: OPEN SHORT PUT SPY, legs [SELL SPY 260227P00580000]

---

### 8. LEAP — parse + rules + market data

**Message:** `<SHORT BADGE /> SPY added another 10 the leaps — total 60 — avg $27.67 — 3/26 — $600`

**Parse**: ticker SPY, keyword "leaps", strike 600, expiry text "3/26".
**Rules**: LEAP → long-dated CALL. Direction LONG (CALL default; Short badge ignored for options).
Expiry "3/26" in LEAP context → March 2026 (or 2027 if past). "Total 60" / "avg $27.67" is
position tracking commentary, not a new trade signal.
**Market data**: confirm SPY 600C exists at the March expiry. Build OCC symbol.

**LLM**: not called.

**Signal**: OPEN LONG CALL SPY, legs [BUY SPY 260326C00600000]

---

### 9. No strikes, expiry hint — parse + rules + market data (ATM inference)

**Message:** `<LONG BADGE /> UNH cds for next week expiration`

**Parse**: ticker UNH, strategy CDS. No strikes. Expiry text "next week".
**Rules**: CDS → direction LONG. Expiry "next week" → next Friday from message date.
Strike selection: ATM inference.
**Market data**: fetch UNH quote → $510. ATM strikes → 510/515 for CDS.
`spreadLegs(CDS, LONG, 510, 515)` → [BUY 510C, SELL 515C]. Build OCC symbols for next Friday.

**LLM**: not called.

**Signal**: OPEN LONG CDS UNH, legs [BUY UNH 260306C00510000, SELL UNH 260306C00515000]

---

### 10. Casual exit language — LLM required

**Message:** Took profits on CRWV calls this morning

**Parse**: no badge, no structured fields. "Took profits" is natural language exit phrasing.
Can't determine action from keywords alone — is this first-person action or commentary?
**Rules**: action unresolved → LLM needed.

**LLM**: receives full message + trader's open positions. Identifies CLOSE CRWV, strategy CALL.

**Market data**: CLOSE uses existing position legs, no new strike/expiry resolution needed.

**Signal**: CLOSE CRWV strategy=CALL

---

### 11. Partial exit — parse + rules only

**Message:** `<EXIT BADGE /> RKLB 1/2`

**Parse**: exit badge, ticker RKLB, fraction "1/2".
**Rules**: exit badge + fraction → TRIM 50%.

**LLM**: not called.
**Market data**: not needed (TRIM uses existing position).

**Signal**: TRIM RKLB exitPercent=0.5

---

### 12. Leg-off — LLM required

**Message:** `<EXIT BADGE /> <LONG BADGE /> UNH cds took small profit hold straight calls`

**Parse**: exit badge, ticker UNH, strategy CDS. But "hold straight calls" is natural language
that means "remove one leg of the spread, keep the calls."
**Rules**: can't distinguish full CLOSE from LEG_OFF without understanding "hold straight calls."

**LLM**: receives message + UNH open position (CDS). Identifies LEG_OFF, targetStrategy=CALL.

**Signal**: LEG_OFF UNH targetStrategy=CALL

---

### 13. Follow trade — LLM with chat history tool

**Message:** following Dave on MSTR

**Parse**: no badge, no structured fields. "Following Dave" is relational language.
**Rules**: relational reference → LLM needed.

**LLM**: receives message + chat history tool. Calls `get_recent_chat`, finds Dave's recent
MSTR trade, mirrors the signal with concrete fields.

**Market data**: concretize the mirrored signal (resolve strikes/expiry if needed).

**Signal**: mirrors Dave's MSTR signal with concrete legs.

---

### 14. Two trades in one message — LLM required

**Message:** `<EXIT BADGE /> <LONG BADGE /> AAPL via AAPU $30.10 (loss) still in other longs, may take short position over the weekend <SHORT BADGE /> GRPN $21.5P next week $1.60`

**Parse**: multiple badge sets, two tickers, interleaved commentary.
**Rules**: complexity flags fire — multi-ticker, extra text, multiple badge groups.

**LLM**: decomposes into two signals — CLOSE AAPL and OPEN SHORT PUT GRPN.

**Market data**: GRPN signal → expiry "next week" + strike 21.5 + premium $1.60. Resolve
expiry, confirm premium, build OCC symbol.

**Signals**: CLOSE AAPL + OPEN SHORT PUT GRPN [SELL GRPN 260306P00021500], statedPremium 1.60

---

### 15. Calendar spread — flag for review

**Message:** `<LONG BADGE /> <SHORT BADGE /> HPE time spread using $23 calls for .09`

**Parse**: both Long and Short badges, "time spread" keyword.
**Rules**: both Long+Short badges without "strangle" → hard skip / flag.

**LLM**: not called.

**Result**: FLAG_FOR_REVIEW — calendar/time spreads not supported.

---

### 16. Commentary — skip

**Message:** NVDA having a great day, wish I had more

**Parse**: no badge, no action verb, no strategy keyword. Ticker NVDA mentioned but
no trade context.
**Rules**: no trade signal detected → SKIP.

**LLM**: not called.

**Result**: SKIP

---

## Eval Gate

Every new resolver, rule, or prompt version runs against the eval fixture suite before
becoming the default. New deterministic paths are also verified against the full
23K message history to confirm they don't produce false positives.
