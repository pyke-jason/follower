import { db, schema } from '../db/client.js';
import { and, eq } from 'drizzle-orm';
import type { TrackedTrader } from '../db/schema.js';

let cachedTraders: Map<string, TrackedTrader> | null = null;
let cacheTime = 0;
// Per-channel set of trader names that are currently associated AND enabled.
// Cached separately from the parent rows so isTrackedTrader can answer
// in O(1) without re-querying the junction on every message.
const channelMembersCache = new Map<string, { names: Set<string>; cachedAt: number }>();
const CACHE_TTL = 60_000; // refresh every minute

async function getTrackedTraders(): Promise<Map<string, TrackedTrader>> {
  if (cachedTraders && Date.now() - cacheTime < CACHE_TTL) {
    return cachedTraders;
  }

  const traders = await db.select().from(schema.trackedTraders).where(eq(schema.trackedTraders.enabled, true));
  cachedTraders = new Map(traders.map(t => [t.name, t]));
  cacheTime = Date.now();
  return cachedTraders;
}

async function getTradersForChannel(channelId: string): Promise<Set<string>> {
  const cached = channelMembersCache.get(channelId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return cached.names;
  }

  const rows = await db
    .select({ name: schema.trackedTraders.name })
    .from(schema.trackedTraders)
    .innerJoin(
      schema.trackedTraderChannels,
      eq(schema.trackedTraderChannels.traderName, schema.trackedTraders.name),
    )
    .where(and(
      eq(schema.trackedTraders.enabled, true),
      eq(schema.trackedTraderChannels.channelId, channelId),
    ));

  const names = new Set(rows.map((r) => r.name));
  channelMembersCache.set(channelId, { names, cachedAt: Date.now() });
  return names;
}

export async function isTrackedTrader(name: string, channelId: string): Promise<boolean> {
  const names = await getTradersForChannel(channelId);
  return names.has(name);
}

export async function getTrader(name: string): Promise<TrackedTrader | undefined> {
  const traders = await getTrackedTraders();
  return traders.get(name);
}
