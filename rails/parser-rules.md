# Parser Rules Inventory

Complete inventory of every rule in `src/intents/orchestrator/parser.ts`.
Each rule is listed with its regex, purpose, and known edge cases.

## Hard Skip Rules

| # | Rule | Regex/Condition | Skip Reason |
|---|------|-----------------|-------------|
| 1 | Paper trade | `/\bpaper\b/i` | "paper trade" |
| 2 | Futures | `/\b(ES\|NQ\|RTY\|YM)[\s/]\|\b(futures?\|futs?)\b/i` | "futures" |
| 3 | Expired worthless | `/\bexpir(?:ed\|es\|ing)?\s+worthless\b/i` | "expired worthless" |
| 4 | Hypothetical | `/^if\s+I\s+(?:were\|was)\b/i` (no badges) | "hypothetical/conditional" |
| 5 | Long+Short without strangle | `hasLongBadge && hasShortBadge && !STRANGLE_RE` | "calendar/time spread not supported" |
| 6 | Non-trade badge only | Badge present but no Long/Short/Exit | "non-trade badge: X" |
| 7 | Blacklisted symbol | `BLACKLISTED_SYMBOLS.has(symbol)` (currently: PLTR) | "blacklisted symbol: X" |
| 8 | Monitoring/observation | `action=null && no badges && MONITORING_RE` | "monitoring/observation" |
| 9 | Prospective intent | `action=null && no badges && PROSPECTIVE_INTENT_RE` | "prospective intent" |
| 10 | No symbol + no action | `symbol=null && action=null` | "no symbol and no action" |
| 11 | Offering | `action=null && no badges && OFFERING_RE` | "monitoring/observation" |

### Known Gaps in Hard Skips

- No skip for educational/tutorial content (long posts about trading methodology)
- No skip for position updates ("still holding X") — caught by monitoring rule only if "I have" or "holding" present
- "Close to" (price target) may false-positive on EXIT_VERB_RE but is caught by EXIT_VERB_FALSE_POSITIVE_RE

## Strategy Detection Rules

| # | Rule | Regex | Strategy | Direction |
|---|------|-------|----------|-----------|
| 1 | CDS | `/\bcds\b\|call debit spread/i` | CDS | LONG |
| 2 | PCS | `/\bpcs\b\|put credit spread\|bull(?:ish)?\s+put\s+spread/i` | PCS | null |
| 3 | PDS | `/\bpds\b\|put debit spread/i` | PDS | LONG |
| 4 | LEAP | `/\bleaps?\b/i` | CALL | LONG |
| 5 | Lotto+calls | LOTTO_RE + CALLS_RE in full text | CALL | LONG |
| 6 | Lotto+no calls | LOTTO_RE only | PUT | LONG |
| 7 | Calls (no spread kw) | CALLS_RE && !SPREAD_KW_RE | CALL | LONG |
| 8 | Puts (no spread kw, no put verb) | PUTS_RE && !SPREAD_KW_RE && !PUT_VERB_RE | PUT | LONG |
| 9 | Stock | STOCK_RE | STOCK | null |
| 10 | Bare P/C abbreviation | `$34 P`, `$180 C` pattern | PUT/CALL | LONG |
| 11 | "put spread" + credit/debit | `/\bput\s+spread\b/i` + context | PCS/PDS | varies |

### Strategy Override Rules

| # | Rule | Condition | Override |
|---|------|-----------|---------|
| 1 | Stock qty override | CALL/PUT detected + comma qty (1,000+) | → STOCK |
| 2 | Stock position override | CALL/PUT detected + STOCK_RE before option kw | → STOCK |
| 3 | Paren-stripped STOCK priority | Strategy found only in parens + stock indicators in primary | → STOCK |
| 4 | Per-share exit override | Exit badge + "per share" + non-STOCK strategy | → STOCK |
| 5 | Badge-implied STOCK | Long/Short badge + no option strategy + $10+ price or comma qty | → STOCK |
| 6 | Ambiguous strategy flag | Long/Short badge + no option strategy + no high price/qty | → LLM |

## Direction Rules

| # | Context | Rule |
|---|---------|------|
| 1 | Lotto | Always LONG |
| 2 | STOCK + Long badge | LONG (badge authoritative) |
| 3 | STOCK + Short badge | SHORT (badge authoritative) |
| 4 | STOCK + no badge | Verb heuristics: bought→LONG, sold/wrote/shorting→SHORT |
| 5 | CALL/PUT + no verbs | Default LONG |
| 6 | CALL/PUT + wrote/writing | SHORT (sell-to-open) |
| 7 | CALL/PUT + sold (not exit) | SHORT |
| 8 | CALL/PUT + bought/buying | LONG (override back) |
| 9 | CDS/PDS | directionFromStrategy (LONG), never overridden |
| 10 | PCS | directionFromStrategy (null), never overridden |

### Direction Edge Cases

- "Short AAPL puts" — "Short" is the badge (bearish view), but direction is LONG (buying puts)
- "Sold AAPL calls" — "Sold" verb → direction SHORT (sell-to-open)
- "Bought back short calls" — This is a LEG_OFF (closing a sold leg), not a new LONG

## Action Rules

### With Exit Badge
| # | Condition | Action |
|---|-----------|--------|
| 1 | LEG_OFF regex | LEG_OFF |
| 2 | Fraction/percent in text | TRIM |
| 3 | Default | CLOSE |

### With Long/Short Badge (no Exit)
| # | Condition | Action |
|---|-----------|--------|
| 1 | "adding"/"added" verb | ADD |
| 2 | Default | OPEN |

### No Badge
| # | Condition | Action | Flag |
|---|-----------|--------|------|
| 1 | Exit verb + symbol (not false positive, not conditional) | CLOSE/TRIM | no_badge_exit |
| 2 | "bought back short calls/puts" | LEG_OFF | (none) |
| 3 | "bought back" + symbol | CLOSE | no_badge_exit |
| 4 | "adding"/"added" | ADD | (none) |
| 5 | "bought"/"buying"/"opened" | OPEN | (none) |
| 6 | "wrote"/"writing" | OPEN | (none) |
| 7 | "sold" (not exit verb) + symbol | OPEN | (none) |
| 8 | Spread/strangle strategy + symbol + no exit/monitoring | OPEN | (none) |
| 9 | None of above | null → LLM | (none) |

## Complexity Flags

| Flag | Trigger | Effect |
|------|---------|--------|
| `multi_ticker` | symbols.length > 1 | → LLM |
| `relational` | "following", "same as", "ty Hari" etc. | → LLM (suppressed for exits) |
| `mixed_action` | Exit badge + Long/Short badge + open intent verb | → LLM |
| `extra_text` | wordCount > 25 + not fully resolved | → LLM |
| `ambiguous_strikes` | Slash pair could be date or strikes (cheap-stock spread) | → LLM |
| `no_badge_exit` | Exit verb without Exit badge | → LLM |
| `ambiguous_strategy` | Badge implies stock but no price/qty confirmation | → LLM |

### Complexity Flag Suppressions

| Suppression | Condition |
|-------------|-----------|
| `relational` removed | Action is CLOSE/TRIM/LEG_OFF + no multi_ticker + no mixed_action |
| `multi_ticker` removed | Exit action + 2 symbols + second is untradable index (VIX, SPX, etc.) |

## Field Extraction (extractTradeFields)

Coordinated token extraction using character positions. Priority order:
1. Dollar amounts near cost-basis keywords → excluded
2. Keyword expiries (0DTE, overnight, next week) → expiry
3. Month + paren number (Sept (19)) → expiry
4. Month + adjacent number → expiry
5. Bare month → expiry
6. Slash pairs → strikes vs date disambiguation
7. Slash dates → expiry
8. LEAP fallback → expiry
9. Dollar/bare number before option keyword → strike
10. Dollar amount after @ or "for $" → premium
11. Number + credit/debit → premium
12. Single remaining unassigned dollar → premium
13. Remaining unassigned dollars → strikes (fallback)
