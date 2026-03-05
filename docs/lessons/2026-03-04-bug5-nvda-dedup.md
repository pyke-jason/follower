## Problem

Two distinct Discord messages (IDs 469068, 469069) arrived 4 seconds apart. They had the same semantic content but message 469069 had a trailing ` \` (space + backslash) — a Discord edit artifact. The existing dedup used `onConflictDoNothing()` on the primary key (message ID). Because the IDs differed, both messages inserted, both got tasks, both got executed as trades: double NVDA SHORT.

## Decision

Three-layer defence:

**Layer 1 — html.ts**: Strip trailing non-content characters (`[\s\\\/;,!?.]+$`) from `htmlToCleanText` output before storing. This makes "Short NVDA $175.44 - 1,000 Shares \" normalize to the same clean_text as "Short NVDA $175.44 - 1,000 Shares", byte-identical after the trailing strip. Protects all future Discord edit artifacts at the source.

**Layer 2 — schema + ingest**: Added `content_hash TEXT` column to `messages` table (sha256 of lowercase, whitespace-collapsed clean_text). Before inserting a message in `ingest.ts`, query for same `author + content_hash` within a 60-second window. If found, skip insertion entirely and log the suppression. Migration: `drizzle/0024_content_hash_dedup.sql`.

**Layer 3 — risk-check.ts**: Added `direction?: string` to `checkRiskLimits` input type. When `action === 'OPEN'` and `direction` is set, check `onSymbol` trades for same `direction + openedAt >= now-30s`. If found, return `allowed: false` with reason `"duplicate open suppressed"`. This is a final broker-side safety net.

## Key Files

- `src/parsing/html.ts` — trailing punctuation strip in `htmlToCleanText`
- `src/db/schema.ts` — `contentHash` column + `idx_messages_content_hash` index on `(author, content_hash)`
- `src/ingestion/ingest.ts` — `normalizeForDedup`, `computeContentHash`, 60s window query before insert
- `src/orders/risk-check.ts` — `DUPLICATE_OPEN_WINDOW_MS = 30_000`, duplicate guard in block 1a
- `src/pipeline/execute-resolved.ts` — passes `direction` to `checkRiskLimits`; interface updated
- `drizzle/0024_content_hash_dedup.sql` — migration for `content_hash` column + index
- `src/live/factory.test.ts` — `contentHash: null` added to test fixture

## Watch Out

- The Layer 2 window query uses `message.timestamp` (from SignalR PostTime), not wall clock. This is correct — it dedupes based on when the messages claim to have been posted.
- `htmlToLLMText` does NOT get the trailing-strip treatment. LLM text has badge markers injected and is not used for dedup; apply consistently only if parsers start using it for content comparison.
- The `content_hash` column is nullable. Existing messages in DB have `NULL` — the dedup query uses `eq()` which will not match NULLs, so no false positives against old rows.
- `scorer.ts` has pre-existing type errors (StockLeg vs OptionLeg) unrelated to this seam.
