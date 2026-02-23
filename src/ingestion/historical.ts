import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import { fetchJson } from './resilient-fetcher.js';
import { classifyMessage } from '../parsing/classify.js';
import { db, schema } from '../db/client.js';
import type { SignalRMessage } from './signalr.js';

const SEARCH_URL = 'https://app.oneoption.com/chat/search-messages';
const CHUNK_DELAY_MS = 500;

// ─── API Response Schema ────────────────────────────

const ApiMessageSchema = z.object({
  Id: z.string(),
  Author: z.string(),
  TimeUtc: z.string(),
  Message: z.string(),
  Tag: z.string().optional().default(''),
  Votes: z.number().optional().default(0),
  Reactions: z.array(z.unknown()).optional().default([]),
});

const ApiResponseSchema = z.object({
  messages: z.array(ApiMessageSchema),
});

type ApiMessage = z.infer<typeof ApiMessageSchema>;

// ─── Active Runs (for cancellation) ─────────────────

const activeControllers = new Map<string, AbortController>();

// ─── Public API ─────────────────────────────────────

export async function fetchHistorical(opts: {
  since: string;
  until: string;
  clearExisting?: boolean;
}): Promise<void> {
  const { since, until, clearExisting = false } = opts;

  // Create the run record
  const runId = crypto.randomUUID();
  await db.insert(schema.historicalFetchRuns).values({
    id: runId,
    status: 'running',
    since,
    until,
    clearExisting,
    startedAt: new Date().toISOString(),
  });

  const controller = new AbortController();
  activeControllers.set(runId, controller);

  console.log(`[Historical] Run ${runId.substring(0, 8)} — fetching ${since} to ${until}`);

  try {
    // Generate date range and create chunk records
    const dates = generateDateRange(since, until);
    await createChunks(runId, dates);

    let totalFetched = 0;
    let totalSaved = 0;

    // Process each chunk
    for (const date of dates) {
      controller.signal.throwIfAborted();

      // Find the chunk — skip if already completed (resumption)
      const [chunk] = await db.select()
        .from(schema.historicalFetchChunks)
        .where(and(
          eq(schema.historicalFetchChunks.runId, runId),
          eq(schema.historicalFetchChunks.date, date),
        ))
        .limit(1);

      if (chunk?.status === 'completed') {
        totalFetched += chunk.fetchedCount ?? 0;
        totalSaved += chunk.savedCount ?? 0;
        continue;
      }

      // Update run's current date
      await db.update(schema.historicalFetchRuns)
        .set({ currentDate: date })
        .where(eq(schema.historicalFetchRuns.id, runId));

      // Mark chunk in_progress
      await db.update(schema.historicalFetchChunks)
        .set({
          status: 'in_progress',
          attempts: (chunk?.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
        })
        .where(eq(schema.historicalFetchChunks.id, chunk!.id));

      try {
        const { fetched, saved } = await fetchDay(date, controller.signal);
        totalFetched += fetched;
        totalSaved += saved;

        await db.update(schema.historicalFetchChunks)
          .set({
            status: 'completed',
            fetchedCount: fetched,
            savedCount: saved,
          })
          .where(eq(schema.historicalFetchChunks.id, chunk!.id));

        console.log(`[Historical] ${date}: ${fetched} fetched, ${saved} new`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await db.update(schema.historicalFetchChunks)
          .set({ status: 'failed', error: errMsg })
          .where(eq(schema.historicalFetchChunks.id, chunk!.id));
        console.error(`[Historical] ${date}: FAILED — ${errMsg}`);
        // Continue to next chunk rather than aborting the whole run
      }

      // Update aggregate counts on run
      await db.update(schema.historicalFetchRuns)
        .set({ fetchedCount: totalFetched, savedCount: totalSaved })
        .where(eq(schema.historicalFetchRuns.id, runId));

      // Polite delay between chunks
      if (date !== dates[dates.length - 1]) {
        await sleep(CHUNK_DELAY_MS, controller.signal);
      }
    }

    // Check if any chunks failed
    const failedChunks = await db.select()
      .from(schema.historicalFetchChunks)
      .where(and(
        eq(schema.historicalFetchChunks.runId, runId),
        eq(schema.historicalFetchChunks.status, 'failed'),
      ));

    const finalStatus = failedChunks.length > 0 ? 'error' : 'completed';
    await db.update(schema.historicalFetchRuns)
      .set({
        status: finalStatus,
        fetchedCount: totalFetched,
        savedCount: totalSaved,
        completedAt: new Date().toISOString(),
        error: failedChunks.length > 0 ? `${failedChunks.length} chunk(s) failed` : null,
      })
      .where(eq(schema.historicalFetchRuns.id, runId));

    console.log(`[Historical] Run ${finalStatus}: ${totalFetched} fetched, ${totalSaved} new messages saved`);
  } catch (err) {
    const isCancelled = controller.signal.aborted;
    const errMsg = err instanceof Error ? err.message : String(err);

    await db.update(schema.historicalFetchRuns)
      .set({
        status: isCancelled ? 'cancelled' : 'error',
        completedAt: new Date().toISOString(),
        error: isCancelled ? 'Cancelled by user' : errMsg,
      })
      .where(eq(schema.historicalFetchRuns.id, runId));

    if (!isCancelled) {
      console.error(`[Historical] Run failed: ${errMsg}`);
      throw err;
    }
    console.log('[Historical] Run cancelled');
  } finally {
    activeControllers.delete(runId);
  }
}

export async function cancelFetch(runId: string): Promise<boolean> {
  const controller = activeControllers.get(runId);
  if (!controller) return false;
  controller.abort(new Error('Cancelled by user'));
  return true;
}

// ─── Internals ──────────────────────────────────────

async function fetchDay(date: string, signal: AbortSignal): Promise<{ fetched: number; saved: number }> {
  const url = `${SEARCH_URL}?term=&author=&since=${date}&until=${date}`;
  const raw = await fetchJson<unknown>(url, signal);

  // The API returns either { messages: [...] } or just an array
  let messages: ApiMessage[];
  if (Array.isArray(raw)) {
    messages = z.array(ApiMessageSchema).parse(raw);
  } else {
    const parsed = ApiResponseSchema.parse(raw);
    messages = parsed.messages;
  }

  let saved = 0;
  for (const apiMsg of messages) {
    const msg = mapToSignalRFormat(apiMsg);
    const classification = classifyMessage(msg.MessageText);

    const result = await db.insert(schema.messages).values({
      id: msg.Id,
      author: msg.User.Name,
      timestamp: msg.PostTime || new Date().toISOString(),
      rawHtml: msg.MessageText,
      cleanText: classification.cleanText,
      badges: classification.badges,
      symbols: classification.symbols,
      actionHint: classification.actionHint,
      directionHint: classification.directionHint,
      detectedStrategies: classification.detectedStrategies,
      isPaperTrade: classification.isPaperTrade,
      confidence: classification.confidence != null ? String(classification.confidence) : null,
    }).onConflictDoNothing();

    if (result.rowsAffected > 0) saved++;
  }

  return { fetched: messages.length, saved };
}

function mapToSignalRFormat(api: ApiMessage): SignalRMessage {
  return {
    Id: api.Id,
    MessageText: api.Message,
    User: { Name: api.Author },
    PostTime: api.TimeUtc,
    Tag: api.Tag ?? '',
    Votes: api.Votes ?? 0,
    Reactions: api.Reactions ?? [],
  };
}

async function createChunks(runId: string, dates: string[]): Promise<void> {
  // Check for existing chunks (resumption case)
  const existing = await db.select()
    .from(schema.historicalFetchChunks)
    .where(eq(schema.historicalFetchChunks.runId, runId));

  if (existing.length > 0) return;

  // Create all chunks
  const values = dates.map(date => ({
    runId,
    date,
    status: 'pending' as const,
  }));

  // Insert in batches of 100 to avoid SQLite limits
  for (let i = 0; i < values.length; i += 100) {
    await db.insert(schema.historicalFetchChunks).values(values.slice(i, i + 100));
  }
}

function generateDateRange(since: string, until: string): string[] {
  const dates: string[] = [];
  const current = new Date(since + 'T00:00:00Z');
  const end = new Date(until + 'T00:00:00Z');

  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
