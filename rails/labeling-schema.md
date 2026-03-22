# Message Labeling Schema

## Storage

Labels go in the existing `message_labels` table:

```sql
CREATE TABLE message_labels (
  id          TEXT PRIMARY KEY,
  message_id  TEXT REFERENCES messages(id) NOT NULL,
  signals     TEXT (JSON Signal[]) NOT NULL DEFAULT '[]',
  source      TEXT NOT NULL DEFAULT 'manual',
  reviewed    INTEGER (boolean) DEFAULT 0,
  notes       TEXT,
  created_at  TEXT,
  updated_at  TEXT
);
```

- **source**: `'audit-agent'` for agent-generated labels, `'manual'` for human-reviewed
- **reviewed**: `false` initially — set `true` after human verification
- **signals**: empty `[]` for SKIP, populated for EXECUTE

## Label Categories

### SKIP (signals = [])

Message is NOT a trade signal. Notes field must contain the skip reason.

Skip reasons (use these exact strings in notes):
- `skip:commentary` — general market talk, analysis, no action
- `skip:question` — asking for advice, not stating a trade
- `skip:paper` — paper trade
- `skip:futures` — futures instrument
- `skip:expired-worthless` — informational, position expired
- `skip:hypothetical` — "if I were...", conditional
- `skip:monitoring` — "watching", "I have", position update without action
- `skip:prospective` — "trying to buy", "looking to sell" — not confirmed
- `skip:non-trade-badge` — Question/Feedback Request badge only
- `skip:calendar-spread` — Long+Short without strangle
- `skip:blacklisted` — blacklisted symbol
- `skip:no-symbol-no-action` — pure commentary, no ticker, no verb
- `skip:duplicate` — same trade already posted
- `skip:reaction-only` — emoji reaction, not a new signal

### EXECUTE (signals populated)

Message IS a trade signal. Signals array contains expected output.

Signal schema (matches `src/agent/schemas.ts`):
```typescript
{
  action: 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF',
  symbol: string,          // e.g. 'AAPL'
  direction?: 'LONG' | 'SHORT',
  strategy: 'CALL' | 'PUT' | 'CDS' | 'PDS' | 'PCS' | 'STOCK',
  statedPremium?: number,
  exitPercent?: number,    // 0.0-1.0 for TRIM
  legs?: [{ strike, expiry?, optionType, action }],
  targetStrategy?: string, // for LEG_OFF only
}
```

### MANUAL_REVIEW (signals = [], notes starts with "review:")

Message is ambiguous — a human must decide. Notes explain why.

## Labeling Rules for Agents

### Badge Authority

1. **Exit badge** → action is CLOSE, TRIM, or LEG_OFF. Never OPEN.
2. **Long badge** (no Exit) → action is OPEN or ADD. Direction usually LONG.
3. **Short badge** (no Exit) → action is OPEN or ADD. Direction may be SHORT (stock) or LONG (buying puts).
4. **No badge** → default to SKIP unless clear trade verb + symbol present.

### Direction Semantics (critical)

- "Short AAPL puts" = BUYING puts (bearish view) → direction: LONG, strategy: PUT
- "Sold AAPL puts" = SELLING puts → direction: SHORT, strategy: PUT
- "Shorting AAPL" (stock) = SHORT selling stock → direction: SHORT, strategy: STOCK
- "Long AAPL calls" = BUYING calls → direction: LONG, strategy: CALL
- "Lotto" / "Yolo" = always direction: LONG (speculative buy)

### Strategy Detection

- CDS = Call Debit Spread
- PDS = Put Debit Spread
- PCS = Put Credit Spread (bullish put spread)
- CALL = naked call option
- PUT = naked put option
- STOCK = shares (look for "shares", "stock", comma-separated qty like "1,000")

### Multi-Signal Messages

Some messages contain multiple trades. Create multiple signals.
- Strangle: 1 CALL signal + 1 PUT signal
- "Bought X and Y": 2 separate signals
- Exit + new entry (mixed action): separate signals with different actions

## Quality Control

- **Confidence**: If unsure about a label, set `reviewed = false` and add uncertainty to notes
- **Never guess strikes/expiry**: If not stated in the message, omit from signal
- **Badge is king**: When badge and text disagree, badge wins (it's set by the trader)
- **Context matters**: "Closed" in "closed near the high" is not an exit — it's market commentary
