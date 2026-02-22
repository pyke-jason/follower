import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { TrackedTraderSchema } from '../db/config-schemas.js';
import type { TrackedTrader } from '../db/config-schemas.js';

let cachedTraders: Map<string, TrackedTrader> | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // refresh every minute

export async function getTrackedTraders(): Promise<Map<string, TrackedTrader>> {
  if (cachedTraders && Date.now() - cacheTime < CACHE_TTL) {
    return cachedTraders;
  }

  const rows = await db.select().from(schema.trackedTraders).where(eq(schema.trackedTraders.enabled, true));
  const traders = z.array(TrackedTraderSchema).parse(rows);
  cachedTraders = new Map(traders.map(t => [t.name, t]));
  cacheTime = Date.now();
  return cachedTraders;
}

export async function isTrackedTrader(name: string): Promise<boolean> {
  const traders = await getTrackedTraders();
  return traders.has(name);
}

export async function getTrader(name: string): Promise<TrackedTrader | undefined> {
  const traders = await getTrackedTraders();
  return traders.get(name);
}
