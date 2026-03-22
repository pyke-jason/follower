# Agent Coordination Rules

## Principles

1. **Badge is ground truth for action type.** Exit badge = exit action. Long/Short badge = entry action. Never override badge authority.
2. **Parser is being audited, not trusted.** Agents label based on the message text and badges, NOT the parser output.
3. **When in doubt, label as MANUAL_REVIEW.** Better to flag ambiguity than guess wrong.
4. **One label per message.** Each message gets exactly one label in `message_labels`.
5. **No hallucinated fields.** Only include strikes, expiry, premium if explicitly stated in the message text.

## Agent Assignment

Each agent receives:
- A date range (e.g., "2025-03-01 to 2025-04-30")
- A badge filter (e.g., "Long only" or "Exit+Long")
- Access to the messages table
- The labeling schema (see labeling-schema.md)

## What Agents Must Do

1. Read each message's `clean_text`, `badges`, `symbols`, `author`
2. Determine the correct label:
   - **SKIP**: Set signals=[], notes="skip:<reason>"
   - **EXECUTE**: Set signals=[{action, symbol, strategy, direction, ...}]
   - **MANUAL_REVIEW**: Set signals=[], notes="review:<reason>"
3. Write the label to `message_labels` table

## What Agents Must NOT Do

- Do NOT modify any existing tables (messages, trades, tasks, etc.)
- Do NOT run the parser or orchestrator — this is an independent audit
- Do NOT label based on what the parser would do — label based on what SHOULD happen
- Do NOT invent ticker symbols — use only what's in the `symbols` column
- Do NOT label strikes/expiry unless explicitly stated in the message text
- Do NOT skip messages — every message in the assigned range must get a label

## Batch Processing

- Process messages in batches of 100
- After each batch, report progress: `{processed: N, skips: N, executes: N, reviews: N}`
- If a batch fails, retry once then report the error

## Edge Case Handling

### Multi-signal messages
If a message contains multiple independent trade signals (e.g., "Bought AAPL calls and TSLA puts"), create multiple signals in the array.

### Strangle messages
Long+Short badges + "strangle" keyword = create 2 signals (CALL + PUT).

### Mixed action messages
Exit badge + Long/Short badge + open intent verb = label as MANUAL_REVIEW with notes explaining the mixed intent.

### Badgeless messages with trade verbs
- "Bought AAPL calls" (no badge) → label as EXECUTE but note "no-badge-open"
- "Sold out of TSLA" (no badge) → label as EXECUTE but note "no-badge-exit"
- The parser flags these with `no_badge_exit` — the label tells us if that flag is justified

### Direction ambiguity
- "Short AAPL" — could be selling stock short OR could be a bearish view opening puts. If no strategy keyword, label as MANUAL_REVIEW.
- "Short AAPL puts" — clearly buying puts with bearish view → LONG direction, PUT strategy

## Quality Checklist (per message)

- [ ] Badge matches the assigned action?
- [ ] Symbol comes from the `symbols` column, not hallucinated?
- [ ] Strategy matches keywords in text (calls, puts, CDS, PDS, PCS, stock, shares)?
- [ ] Direction follows the rules in labeling-schema.md?
- [ ] For exits: is there actually an exit being described, or just commentary?
- [ ] For entries: is the trader announcing a filled trade, or just contemplating?
