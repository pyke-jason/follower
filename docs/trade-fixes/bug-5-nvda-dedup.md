# BUG-5: Duplicate NVDA SHORT from Near-Duplicate Messages

## Root Cause

Two distinct Discord messages (IDs 469068 and 469069) arrived 4 seconds apart. They carry the
same semantic content but differ by a trailing ` \` (space + backslash) in message 469069 — a
known Discord edit artifact.

The dedup guard in `createTaskFromMessage` (`src/live/factory.ts`) uses
`onConflictDoNothing()` on the `tasks(message_id)` unique index. Because the two messages have
**different** Discord message IDs, each gets its own row in `messages` and its own task in
`tasks`. The unique constraint fires only when the exact same message ID is seen twice (i.e.,
pure duplicate delivery), not when two distinct IDs carry equivalent content.

There is no content-level or time-window dedup anywhere in the pipeline.

## Evidence

```
msg 469068: "Short NVDA $175.44 - 1,000 Shares"   (33 bytes, ends 0x726573 "res")
msg 469069: "Short NVDA $175.44 - 1,000 Shares \" (35 bytes, ends 0x73205C "s \")
```

Timestamp gap: **4.0 seconds** (2025-09-24T16:12:42Z vs 2025-09-24T16:12:46Z).

Both trades opened at the same broker fill time (2025-09-24T16:27:05Z), 28 shares SHORT NVDA
@ $176.12. DB query confirms multiple backtest runs also duplicated from these two message IDs,
indicating the duplication is structural and reproducible, not a one-off.

The `htmlToCleanText` function (`src/parsing/html.ts`) trims whitespace but does NOT strip the
backslash character. A trailing `\` is a punctuation character, not whitespace, so `.trim()`
leaves it intact. Result: two textually-different `clean_text` values → two message rows →
two tasks → two trades.

The risk check (`src/orders/risk-check.ts`) uses `maxOnSymbol: 5` for live, so 2 positions on
NVDA passes without complaint.

## Proposed Fix

**Two-layer defence:**

### Layer 1 — Normalize at parse time (primary fix, low risk)

Strip trailing punctuation-only sequences (`[,;.!?\\\/\s]+`) in `htmlToCleanText` before
returning `cleanText`. This is the simplest, most targeted change: the backslash (and similar
Discord artifacts) disappears before `clean_text` is stored, making the two messages
byte-identical and allowing the existing `messages(id)` primary key dedup to handle it at the
task level if the same message re-fires — though that still won't help for genuinely distinct
message IDs.

More impactful: add a **normalized-text fingerprint** to the `messages` table as a unique index.

```sql
ALTER TABLE messages ADD COLUMN content_hash TEXT;
CREATE UNIQUE INDEX idx_messages_content_hash_author_window
  ON messages (author, content_hash, <time-bucket>);
```

Where `content_hash = sha256(normalizedText)` and the time-bucket is a 60-second floor of
`timestamp`. On conflict, skip insertion (`onConflictDoNothing`). This is a schema change
requiring a migration.

### Layer 2 — Near-duplicate guard in `createTaskFromMessage` (defense-in-depth)

Before inserting the task, query for any task created within a configurable window
(e.g., 60 seconds) for the same `author` where `context->>'cleanText'` normalizes to the same
fingerprint:

```ts
// src/live/factory.ts
const normalizedText = normalizeForDedup(message.cleanText);
// normalizeForDedup: lowercase, collapse whitespace, strip trailing punctuation

const recentDuplicate = await db.select({ id: schema.tasks.id })
  .from(schema.tasks)
  .where(and(
    eq(schema.tasks.status, 'PENDING'),
    // JSONB extract: context->>'cleanText' normalized
    sql`json_extract(context, '$.cleanText') LIKE ${normalizedText + '%'}`,
    sql`created_at > ${windowStart.toISOString()}`,
  ))
  .limit(1);

if (recentDuplicate.length > 0) {
  console.log(`[Factory] Near-duplicate task suppressed for message ${message.id}`);
  return null;
}
```

This is in-process, requires no schema migration, but relies on JSONB extraction which is
less reliable than a proper index. Treat as a backstop, not the primary fix.

### Layer 3 — Risk check: block identical position within time window

In `checkRiskLimits`, if `action === 'OPEN'` and there is already an OPEN trade on the same
symbol+direction opened within the last 30 seconds, block with reason
`"duplicate open suppressed (same position opened < 30s ago)"`. This catches broker-side
duplicates that sneak past task dedup.

This is the strongest final safety net but adds latency to every OPEN risk check and requires
a timestamp query.

**Recommended priority: Layer 1 (normalize + content_hash index) > Layer 3 (risk time-window
guard) > Layer 2 (factory text comparison).**

## Files Touched

| File | Change |
|------|--------|
| `src/parsing/html.ts` | Strip trailing non-word/non-price chars in `htmlToCleanText` |
| `src/db/schema.ts` | Add `contentHash` column + unique index on `(author, contentHash, timeBucket)` |
| `src/ingestion/ingest.ts` | Compute and store `contentHash` on insert |
| `src/live/factory.ts` | Optional: near-duplicate query before task insert |
| `src/orders/risk-check.ts` | Optional: time-window guard on OPEN for same symbol+direction |
| `drizzle/migrations/` | New migration for content_hash column |

## Risk

- **Layer 1 normalization**: Very low. Stripping trailing backslashes/punctuation from chat
  text has no adverse effect on parsing — none of the symbol/price/action parsers rely on
  trailing characters.
- **Content hash unique index**: Medium. Need to ensure the hash function is deterministic and
  that migration handles existing rows (backfill or allow NULL with partial unique index).
- **Layer 3 time-window risk check**: Low-medium. Adds one DB read per OPEN signal. Correct
  clock ordering needed — if trades are recorded with a static `opened_at` from the message
  timestamp (not wall clock), the window query must use the correct column.

## Intersections

- **BUG-2 (Missed TSLA close)**: Different bug, but both reveal a gap in the "one-task-per
  message" assumption — BUG-2 is a missed task, BUG-5 is an extra task. The dedup mechanism
  in `factory.ts` should be reviewed holistically.
- **ISSUE-3 (Concatenated messages)**: Also touches message content normalization. If we
  normalize `clean_text` more aggressively, ensure it doesn't collapse legitimately distinct
  multi-trade messages.
- **Risk check refactor**: Layer 3 adds to `checkRiskLimits`. Coordinate with any risk check
  changes from BUG-1 or BUG-4 analyses to avoid conflicts.
- **Schema migration**: Content-hash column migration should be batched with any other
  pending schema changes to minimize migration runs.

## Reviewer Verification

Verified 2026-03-04 against `data/trade-follower.db` and current source code.

### 1. Messages 469068 and 469069 — Existence and Content

**CONFIRMED.** Both messages exist in the `messages` table.

```sql
SELECT id, author, timestamp, clean_text, length(clean_text) as len,
       hex(clean_text) as hex_text, badges, symbols
FROM messages WHERE id IN ('469068', '469069') ORDER BY id;
```

| id | author | timestamp | clean_text | len | hex (last 6) | badges | symbols |
|----|--------|-----------|------------|-----|-------------|--------|---------|
| 469068 | Hariseldon | 2025-09-24T16:12:42.000Z | `Short NVDA $175.44 - 1,000 Shares` | 33 | ...726573 | `["Short"]` | `["NVDA"]` |
| 469069 | Hariseldon | 2025-09-24T16:12:46.000Z | `Short NVDA $175.44 - 1,000 Shares \` | 35 | ...73205C | `[]` | `["NVDA"]` |

Byte-by-byte diff: positions 33 and 34 differ (space 0x20 + backslash 0x5c appended to msg 469069).
The bug report's hex values (0x726573 "res" and 0x73205C "s \") are exact matches.

**Additional finding not in bug report:** The badges differ. Message 469068 has `["Short"]` (from
a `<span class="badge bg-danger">Short</span>` in its HTML). Message 469069 has `[]` (no badge
span; its HTML wraps content in a plain `<div>` with the word "Short" as bare text). This means
the two messages are not just text variants — they have structurally different HTML. Message 469069
appears to be an edit-artifact re-post that lost the badge span entirely.

### 2. Timestamp Gap

**CONFIRMED.** 4.0 seconds exactly.

```sql
SELECT (julianday('2025-09-24T16:12:46.000Z') - julianday('2025-09-24T16:12:42.000Z')) * 86400;
-- Result: 4.00001853704453 (4.0 seconds within float precision)
```

### 3. Duplicate Trades

**CONFIRMED but scale is larger than reported.** The bug report says "Both trades opened at the
same broker fill time (2025-09-24T16:27:05Z), 28 shares SHORT NVDA @ $176.12" — implying 2 trades.
The actual count is much worse.

```sql
SELECT source_message_id, count(*) as cnt
FROM trades
WHERE symbol = 'NVDA' AND direction = 'SHORT'
  AND source_message_id IN ('469068', '469069')
GROUP BY source_message_id;
```

| source_message_id | count |
|---|---|
| 469068 | 34 |
| 469069 | 16 |

**50 total trades** from these two messages across all runs. At the specific `$176.12 / 28 shares`
entry point, there are 10 trades from msg 469068 and 6 from msg 469069 (16 trades for one signal).

The bug report's statement of "both trades" is an understatement. The duplication is not just
between the two messages — it is also replicated across multiple backtest runs, each of which
independently creates task+trade pairs from both messages.

### 4. Backtest Duplication

**CONFIRMED.** Both messages appear in run_decisions across many backtest runs.

```sql
SELECT message_id, count(*) as total,
       sum(CASE WHEN trade_id IS NOT NULL THEN 1 ELSE 0 END) as with_trade
FROM run_decisions WHERE message_id IN ('469068', '469069')
GROUP BY message_id;
```

| message_id | total | with_trade |
|---|---|---|
| 469068 | 108 | 0 |
| 469069 | 99 | 0 |

207 run_decision rows total. The `trade_id` column is NULL in all of them (these appear to use the
legacy `decision`/`path` columns instead). The structural duplication is confirmed: every backtest
run that processes these messages creates independent task+trade pairs from both.

### 5. htmlToCleanText Trailing Backslash Behavior

**CONFIRMED with nuance — the fix is already applied in current source.**

The current `src/parsing/html.ts` (line 20) contains:

```ts
text = text.replace(/[\s\\\/;,!?.]+$/, '');
```

This regex DOES strip trailing backslashes. However, the bug report describes the **original**
behavior where only `.trim()` was used. The existing `clean_text` values in the DB (35 bytes with
trailing ` \` for msg 469069) confirm the data was ingested **before** this fix was applied. The
fix has been implemented in code but the DB has not been re-ingested.

Verification: `.trim()` on `"Short NVDA $175.44 - 1,000 Shares \"` leaves the backslash intact
(length stays 35). The new regex strips both ` \` producing identical 33-byte strings.

### 6. Tasks Table

**CONFIRMED — all tasks are backtest-scoped.** The bug report says "each gets its own task."

```sql
SELECT message_id,
  count(*) as total,
  count(DISTINCT channel_id) as distinct_channels
FROM tasks WHERE message_id IN ('469068', '469069')
GROUP BY message_id;
```

| message_id | total | distinct_channels |
|---|---|---|
| 469068 | 17 | 17 |
| 469069 | 9 | 9 |

All tasks have `bt:` channel_ids — each belongs to a different backtest run. Zero non-backtest
tasks exist for these messages (or any messages in the DB). An earlier version of this analysis
incorrectly used `id NOT LIKE 'bt:%'` to identify non-backtest tasks, but older backtest runs
generate UUID-style task IDs (not `bt:` prefixed). The correct filter is
`channel_id NOT LIKE 'bt:%'`.

The `onConflictDoNothing()` guard in factory.ts is still a dead letter (the unique index doesn't
exist), but this has not caused damage because no live ingestion has run to create live tasks.

### 7. risk-check.ts maxOnSymbol

**CONFIRMED.**

```
src/config/risk-defaults.ts:12:  maxOnSymbol: 5,
src/orders/risk-check.ts:10:  maxOnSymbol: number;  // live: 5, backtest: 3
```

`LIVE_RISK_DEFAULTS.maxOnSymbol = 5`. Two NVDA positions would not trigger this limit.

**Additional finding:** Layer 3 (the duplicate OPEN time-window guard) has already been
implemented in the current source at `src/orders/risk-check.ts` lines 74-97:

```ts
const DUPLICATE_OPEN_WINDOW_MS = 30_000; // 30-second window
```

This was proposed in the bug report but is already present in the codebase.

### 8. factory.ts Dedup Logic

**PARTIALLY CONFIRMED / CRITICAL DISCREPANCY.** The bug report claims `onConflictDoNothing()` fires
on `tasks(message_id)` unique index. The code at `src/live/factory.ts` line 43-49 does use
`onConflictDoNothing()`. However:

**The unique index `idx_tasks_message_unique` defined in `schema.ts` (line 76) does NOT exist in the
actual SQLite database.**

```sql
SELECT name, sql FROM sqlite_master WHERE tbl_name='tasks' AND type='index';
```

| name | sql |
|---|---|
| sqlite_autoindex_tasks_1 | (PK autoindex) |
| idx_tasks_status | on (status) |
| idx_tasks_message | on (message_id) -- **non-unique** |
| idx_tasks_backtest_run | on (backtest_run_id) |
| idx_tasks_channel | on (channel_id) |

There is no `idx_tasks_message_unique`. The migration that would create it was either never run or
never generated. This means `onConflictDoNothing()` in `factory.ts` is a **dead letter** — it has
no unique constraint to conflict against and will ALWAYS insert. This explains why message 469068
has 9 non-backtest tasks instead of 1.

Proof that this is systemic, not limited to this message:

```sql
SELECT message_id, count(*) as cnt FROM tasks
WHERE message_id IS NOT NULL AND id NOT LIKE 'bt:%'
GROUP BY message_id HAVING cnt > 1
ORDER BY cnt DESC LIMIT 5;
```

| message_id | count |
|---|---|
| 463339 | 38 |
| 463583 | 32 |
| 464011 | 29 |
| 463386 | 28 |
| 463393 | 27 |

Hundreds of messages have duplicate tasks. The dedup guard is completely broken.

### 9. content_hash Column

**PARTIALLY IMPLEMENTED.** The column exists in both `schema.ts` (line 31) and the actual DB:

```sql
PRAGMA table_info(messages);
-- Row 14: content_hash, TEXT, nullable
```

The migration `drizzle/0024_content_hash_dedup.sql` was applied. However:

- The index is **non-unique** (`CREATE INDEX`, not `CREATE UNIQUE INDEX`) — it cannot enforce dedup.
- The index is on `(author, content_hash)` — no time-bucket component as proposed in the bug report.
- **Zero rows have content_hash populated:** `SELECT count(*) FROM messages WHERE content_hash IS NOT NULL;` returns 0.

The column exists but is unpopulated for historical data. `src/ingestion/ingest.ts` (lines 169-204)
DOES compute and store contentHash for new live-ingested messages, but this code hasn't been
exercised because live ingestion hasn't run since the code was added. `src/ingestion/historical.ts`
(the historical fetch path) does NOT compute contentHash — this is a gap that needs fixing.

### 10. Hex Comparison

**CONFIRMED** via scratchpad script (deleted after verification).

```
text1 (469068): 33 chars, last 3 hex: 726573 ("res")
text2 (469069): 35 chars, last 3 hex: 73205c ("s \")
Diff at positions 33-34: space (0x20) + backslash (0x5c)
After current regex strip: both produce identical 33-char strings
After .trim() only: NOT identical (35 chars vs 33 chars)
```

### Summary of Discrepancies

1. **Bug scope understated.** The bug report implies 2 duplicate trades. The actual count is 50
   trades across both messages and multiple runs. However, all tasks and trades are backtest-scoped
   (zero live tasks exist). The cross-run duplication is expected behavior.

2. **tasks unique index does not exist.** The bug report assumes `onConflictDoNothing()` works but
   is bypassed by different message IDs. In reality, it does not work AT ALL because the unique
   index was never created in the database. This is a strictly worse situation — even re-delivery
   of the exact same message ID would create duplicate tasks.

3. **Badge difference not mentioned.** Message 469069 has empty badges `[]` while 469068 has
   `["Short"]`. The HTML structures differ significantly (badge span vs bare div). This means the
   two messages are not merely "text variants with a trailing backslash" — they represent
   structurally different Discord renderings.

4. **Proposed fixes partially already implemented.** Layer 1 (trailing strip regex) is in the
   current `htmlToCleanText`. Layer 3 (30-second duplicate OPEN guard) is in `risk-check.ts`.
   Neither is retroactive on existing DB data.

5. **content_hash column exists but is non-functional.** Present in schema and DB, but: index is
   non-unique, no time-bucket component, and zero rows populated.

### Confidence Assessment

- **Root cause identification**: HIGH confidence. The trailing backslash difference and missing
  dedup are real. The primary defense (content_hash dedup in ingest.ts) is already implemented
  in code but hasn't run against historical data. The tasks unique index is defense-in-depth.
- **Proposed fix adequacy**: HIGH confidence. Layer 1 (parse normalization + content_hash) is
  already in code. The missing unique index on tasks is the remaining gap — but must use
  `UNIQUE(channel_id, message_id)`, NOT `UNIQUE(message_id)`, to support the multi-channel model.
- **Recommended immediate action**: (1) Fix schema.ts to use composite unique index, (2) create
  migration 0025 with the correct index, (3) fix factory.ts to pass channelId, (4) backfill
  content_hash for historical messages.
- **Damage**: Zero. No live tasks exist. All "duplicates" are cross-backtest-run (expected).
  The missing index is a latent bug that would manifest on first live ingestion.

## Fix Plan (Verified)

Verified 2026-03-04 against live DB (`data/trade-follower.db`) with damage assessment script
(`scratchpad/bug5-damage.ts`).

### Problem Summary

Three independent issues compound:

1. **Primary defense already implemented but not backfilled**: `ingest.ts` computes `contentHash`
   and performs near-duplicate suppression (same author + hash + 60s window) on new messages.
   But 23,573 historical messages have NULL content_hash. The primary fix is a backfill.

2. **Missing unique index (defense-in-depth)**: `idx_tasks_message_unique` defined in `schema.ts:76`
   was never created in the actual DB. Migration 0010 partially applied (ALTERs ran, CREATE INDEX
   statements did not). Drizzle recorded it as complete. `onConflictDoNothing()` in `factory.ts`
   is a dead letter.

3. **Wrong index definition**: The schema defines `UNIQUE(message_id) WHERE message_id IS NOT NULL`.
   This is incompatible with the multi-channel model — backtests legitimately create one task per
   message per run. 789 message_ids span multiple channels. Creating the index as-is would fail.

Additionally:
- `content_hash` column exists but has zero populated rows (23,573 messages with NULL).
  `ingest.ts` already computes it for new messages — only a historical backfill is needed.
- `factory.ts` does not set `channelId` on tasks, making a composite unique index ineffective.
- Schema drift: `backtest_run_id` column + `idx_tasks_backtest_run` index exist in DB but not
  in `schema.ts`. This is intentional per migration 0023 — `channel_id` replaced it. Drizzle
  ignores unmapped columns. No action needed.
- Dead code: `messageIntents` table definition in `schema.ts` (lines 310-328) plus types
  `MessageIntent`, `NewMessageIntent`, `IntentStep` are dead — the table was dropped in
  migration 0019. No code imports these. Should be removed from schema.ts.

### Damage Assessment (Real Data)

- **Intra-channel duplicate tasks**: 0 (no live tasks exist yet — system has only run backtests)
- **Cross-channel duplicates**: 789 message_ids across 54 backtest channels (expected behavior)
- **Duplicate trades within same channel**: 107 extra trades (e.g., msg 469732 produced 3 identical
  BE SHORT PUT trades in same backtest run — likely multi-signal LLM output, not missing index)
- **Live mode damage**: None yet, but first live message would be unprotected

### Step 1: Fix schema.ts — composite unique index

Change the unique constraint from `UNIQUE(message_id)` to `UNIQUE(channel_id, message_id)`:

```ts
// src/db/schema.ts, tasks table indexes
uniqueIndex('idx_tasks_message_unique')
  .on(table.channelId, table.messageId)
  .where(sql`message_id IS NOT NULL`)
```

**Rationale**: Backtests create one task per message per run, each scoped by `channel_id`.
Live mode has one channel (`live:<accountId>`). The composite key prevents duplicates within
a channel while allowing the same message across channels.

Verification: `SELECT COUNT(*) FROM (SELECT channel_id, message_id FROM tasks WHERE message_id
IS NOT NULL GROUP BY channel_id, message_id HAVING COUNT(*) > 1)` returns **0** — no conflicts.

### Step 2: Fix factory.ts — pass channelId

`createTaskFromMessage` must accept and store `channelId`, with a runtime guard:

```ts
export async function createTaskFromMessage(
  message: Message,
  channelId: string,
): Promise<string | null> {
  if (!channelId) throw new Error('channelId required for task creation');
  // ... existing logic ...
  const [task] = await db.insert(schema.tasks).values({
    messageId: message.id,
    channelId,          // <-- NEW
    taskType,
    status: 'PENDING',
    assignee: 'agent',
    context,
  }).onConflictDoNothing().returning();
```

The runtime guard ensures dedup failure is loud, not silent — if channelId were NULL, SQLite's
unique index would treat each `(NULL, message_id)` as distinct, silently bypassing the constraint.

Caller in `src/index.ts:65` must pass `liveChannelId`:
```ts
await createTaskFromMessage(stored[0], liveChannelId);
```

### Step 3: Write migration 0025

```sql
-- Fix partially-applied migration 0010: create missing unique index with correct composite key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_message_unique
  ON tasks(channel_id, message_id) WHERE message_id IS NOT NULL;
```

No deduplication needed — zero intra-channel duplicates exist.

Note: `idx_intents_unique` is NOT needed — the `message_intents` table was dropped in migration
0019. The table definition in `schema.ts` is dead code (see Step 5).

### Step 4: Backfill content_hash

Write a one-time migration/script that populates `content_hash` for all 23,573 messages:

```ts
import { createHash } from 'crypto';

function contentHash(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}
```

This can run in a batch UPDATE. The `idx_messages_content_hash` non-unique index already exists
on `(author, content_hash)` for efficient lookups.

### Step 5: Update test fixtures

`src/backtest/test-fixtures.ts` line 356-359: update `CREATE_TASKS_UNIQUE_IDX` to match the
new composite constraint:

```ts
export const CREATE_TASKS_UNIQUE_IDX = sql`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_message_unique
  ON tasks(channel_id, message_id) WHERE message_id IS NOT NULL
`;
```

The factory test (`src/live/factory.test.ts`) must also create tasks with a `channel_id` value
for the dedup test to work.

### Step 6: Remove dead messageIntents from schema.ts

The `messageIntents` table definition (lines 310-328), types (`MessageIntent`, `NewMessageIntent`,
`IntentStep`), and the `idx_intents_unique` index are dead code. Migration 0019 dropped the table.
No code imports these types. Remove them from schema.ts.

### Step 7: Fix historical.ts — add contentHash

`src/ingestion/historical.ts` (lines 203-216) inserts messages WITHOUT computing `contentHash`.
This is a second ingestion path alongside `ingest.ts`. Add `contentHash` computation using the
same `normalizeForDedup()` + `computeContentHash()` functions from `ingest.ts` (or extract them
to a shared module).

### Separate Issue: 107 duplicate trades (NOT BUG-5)

107 duplicate trades exist within the same backtest channels (e.g., msg 469732 has 3 identical
BE SHORT PUT trades in `bt:26f47531-...`). These are NOT caused by the missing unique index —
each message has exactly 1 task per channel. The duplicates come from the LLM/executor producing
multiple identical signals per message. This is a separate bug and should be tracked independently.

### Files Touched

| File | Change |
|------|--------|
| `src/db/schema.ts` | Fix `idx_tasks_message_unique` to `(channelId, messageId)` + remove dead `messageIntents` |
| `src/live/factory.ts` | Accept `channelId` param with runtime guard, pass to insert |
| `src/live/factory.test.ts` | Update dedup test to set channelId |
| `src/index.ts` | Pass `liveChannelId` to `createTaskFromMessage` |
| `src/ingestion/historical.ts` | Add contentHash computation to historical fetch path |
| `src/backtest/test-fixtures.ts` | Update `CREATE_TASKS_UNIQUE_IDX` |
| `drizzle/0025_*.sql` | New migration: create tasks unique index only |
| `scratchpad/backfill-content-hash.ts` | One-time backfill script for 23,573 messages |

### Risk

- **Low**: Composite unique index has zero conflicts in current data.
- **Low**: Adding `channelId` param to `factory.ts` is additive; only one caller (`index.ts`).
- **Low**: Removing dead `messageIntents` from schema.ts — no consumers exist.
- **Medium**: Backfilling content_hash for 23K rows takes a few seconds but is safe (no unique
  constraint on content_hash — it's a non-unique index for lookup efficiency).
- **None**: `IF NOT EXISTS` prevents migration failure if indexes are somehow already present.
