# Direction Derivation Rules

**The principle**: `direction` (LONG/SHORT) is almost always deterministic from the strategy noun
or authoritative verbs in the message body. The LLM should never use the Long/Short badge to
infer trade direction for options — badges describe the trader's stock view, not what they traded.

---

## Badge Encoding (inline markers, not extracted text)

Badges are Discord role labels prepended to messages. The raw HTML looks like:

```html
<span class="badge bg-success">Long</span>&nbsp;BE sold Oct $59 put $2.40
```

**Do NOT flatten badges into plain text** (`Long BE sold Oct $59 put $2.40`) — "Long" becomes
indistinguishable from an English direction word and will cause wrong direction on credit trades.

Instead, `htmlToLLMText()` in `src/parsing/html.ts` replaces badge spans with inline XML markers:

```
<LONG BADGE /> BE sold Oct $59 put $2.40
```

The LLM sees clearly-demarcated metadata. The `cleanText` stored in the DB remains human-readable
plain text (used for display and search); `htmlToLLMText` is only called at prompt-build time.

All message context passed to the LLM uses this encoding:
- Current message: `buildIntentPrompt()` in `extract-intent.ts`
- Recent trader messages: `formatTraderContext()` / `formatChatContext()` in `trader-context.ts`

Badge marker format: `<EXIT BADGE />`, `<LONG BADGE />`, `<SHORT BADGE />`, `<QUESTION BADGE />`, etc.
(uppercase badge name + space + `BADGE />`)

---

## What Badges Mean

| Badge | Meaning | Effect on direction |
|---|---|---|
| `<LONG BADGE />` | Bullish stock view | **Ignore for options.** Only relevant for STOCK strategy. |
| `<SHORT BADGE />` | Bearish stock view | **Ignore for options.** Only relevant for STOCK strategy. |
| `<EXIT BADGE />` | Closing a position | Indicates CLOSE/TRIM action, not direction. |

---

## Direction by Strategy

| Strategy | Direction | Rule |
|---|---|---|
| `CDS` | Always LONG | Call debit spread = buying calls. Ignore all badges. |
| `PDS` | Always LONG | Put debit spread = buying puts. Ignore all badges. |
| `PCS` | Always SHORT | Put credit spread = selling puts. Normalize via `pcsNormalize` postprocess: `PCS → {PDS, SHORT}`. |
| `CALL` | Default LONG | "Sold/wrote" → SHORT (rare). Ignore badges entirely. |
| `PUT` | Verb-derived | "Sold/wrote/writing" → SHORT. Everything else → LONG. Ignore badges. |
| `STOCK` | Badge-derived | `<LONG BADGE />` → LONG. `<SHORT BADGE />` → SHORT. Authoritative verbs override. |

---

## Authoritative Verbs (override strategy defaults)

| Verb | Direction | Notes |
|---|---|---|
| `"sold"` | SHORT | Sell-to-open. But "sold half" = TRIM (exit), not open. Context required. |
| `"wrote"` / `"writing"` | SHORT | Always sell-to-open. |
| `"bought"` / `"buying"` | LONG | Always buy-to-open. |
| `"lotto"` / `"yolo"` | LONG | Speculative buy; overrides all badges and verbs. Never sell-to-open. |

---

## Multi-Trade Messages

Badge arrays can contain duplicate or mixed entries when a trader posts multiple trades in one
message. Two structurally distinct patterns:

**Pattern 1 — Single multi-leg position** (strangle, straddle, time spread):
Both `<LONG BADGE />` and `<SHORT BADGE />` present, one symbol. Instrument noun ("strangle",
"straddle", "time spread") is the discriminator.
```
<LONG BADGE /> <SHORT BADGE /> SPY strangle for overnight
→ Two OPEN signals: LONG CALL + LONG PUT
```

**Pattern 2 — Two separate trades concatenated** (different symbols, no separator):
Badge array has repeated Exit entries. Clean text runs two trades together.
```
badges: ["Exit","Long","Exit","Short"]
<EXIT BADGE /> <LONG BADGE /> DXCM $80.10 (9/4 8:50am)<EXIT BADGE /> <SHORT BADGE /> ELF $135.74
→ Two separate CLOSE signals
```

When both patterns are possible, the instrument noun disambiguates:
"strangle"/"straddle"/"time spread" → Pattern 1 (one position). Two distinct symbols → Pattern 2.

---

## Implementation

| Rule | Location |
|---|---|
| Badge → `<X BADGE />` marker | `htmlToLLMText()` in `src/parsing/html.ts` |
| `PCS → {PDS, SHORT}` normalization | `pcsNormalize` in `src/intents/postprocess.ts` (TODO) |
| `lotto/yolo → LONG` override | `lottoDirectionFix` in `src/intents/postprocess.ts` |
| `wrote/writing → SHORT` override | `soldWroteDirectionFix` in `src/intents/postprocess.ts` |
| Spread legs from strategy+direction | `spreadLegs()` in `src/lib/spread-legs.ts` |

The LLM only needs to determine direction for:
1. **Naked PUT**: look for sell verbs → SHORT; default LONG
2. **STOCK**: read `<LONG BADGE />` / `<SHORT BADGE />` or authoritative verb

For all spread strategies and CALL, direction is either postprocessed or defaults to LONG.
