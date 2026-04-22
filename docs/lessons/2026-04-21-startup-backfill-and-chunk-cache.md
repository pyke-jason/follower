# 2026-04-21 — Startup backfill + cross-run chunk cache

## Problem

Opening the app did not backpopulate messages for the current day / week / month.
Two causes:

1. `gapFill()` in `src/ingestion/ingest.ts` was gated behind `!isFirstBoot`, so
   the first boot after a cold start never fetched anything. Only reconnects
   triggered a fill.
2. Even when it did run, `gapFill()` called `fetchHistorical({ since: today, until: today })`,
   so it could never repair a multi-day offline gap.

And every `fetchHistorical()` call re-hit `/chat/search-messages` for every
day in the range. The only "skip completed chunk" check was scoped to the
same run — prior runs' completed chunks were ignored, so repeated starts
re-fetched the same historical days.

## Decision

- Run gap-fill on first boot too. First boot uses a 30-day window
  (`INITIAL_BACKFILL_DAYS`, default 30). Reconnects keep today-only.
- Add a cross-run completed-chunk cache in `historical.ts`. Before fetching a
  date, look for a prior run's completed chunk for that same date whose
  `run.startedAt` is after end-of-day UTC for that date. If found, skip the
  API call. The `startedAt >= endOfDay` constraint ensures the prior fetch
  happened *after* the day was fully settled — otherwise we'd cache a day
  that was cut short mid-session.
- Today's chunk is never cacheable by construction (its end-of-day is in the
  future), so today is always re-fetched.

## Key Files

- `src/ingestion/ingest.ts` — `gapFill(daysBack)` takes a window; supervisor
  passes `INITIAL_BACKFILL_DAYS` on first boot, `0` on reconnect.
- `src/ingestion/historical.ts` — `findCachedChunk()` does the cross-run
  cache lookup (join `historical_fetch_chunks` → `historical_fetch_runs`,
  filter on `status='completed'` + `startedAt >= endOfDay`). Main loop
  consults it before `fetchDay()`.
- `src/db/schema.ts` — `historicalFetchRuns.startedAt` and
  `historicalFetchChunks.status` were already present; no schema change.

## Watch Out

- The cache key is the UTC date string from `isoToDateKey()`. The OneOption
  API's `since`/`until` also treats days in UTC (via `until = date + 1`),
  so the day boundary is consistent. If the ingestion ever moves to ET-based
  day keys, the `endOfDay` math in `findCachedChunk()` must move with it.
- `savedCount` on a cache hit is recorded as 0 because re-inserting would
  dedupe to zero new rows anyway. `fetchedCount` reflects the original run.
- Dedup on insert (`onConflictDoUpdate` on `messages.id`) still protects
  against double-writes if the cache check is ever wrong.
