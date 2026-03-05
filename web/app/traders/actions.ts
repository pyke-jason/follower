'use server';

import { db, schema } from '@/lib/db';
import { eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

const DEFAULT_STRATEGIES = ['CDS', 'PDS', 'CALL', 'PUT', 'STOCK'];

function refresh() {
  revalidatePath('/traders');
  revalidatePath('/');
}

export async function quickAdd(name: string) {
  if (!name?.trim()) return;
  await db.insert(schema.trackedTraders).values({
    name: name.trim(),
    enabled: true,
    strategies: DEFAULT_STRATEGIES,
    notes: null,
  });
  refresh();
}

export async function removeTrader(name: string) {
  if (!name) return;
  await db
    .delete(schema.trackedTraders)
    .where(eq(schema.trackedTraders.name, name));
  refresh();
}

export async function toggleEnabled(name: string, currentlyEnabled: boolean) {
  if (!name) return;
  await db
    .update(schema.trackedTraders)
    .set({ enabled: !currentlyEnabled })
    .where(eq(schema.trackedTraders.name, name));
  refresh();
}

export async function setStrategies(name: string, strategies: string[]) {
  if (!name) return;
  await db
    .update(schema.trackedTraders)
    .set({ strategies })
    .where(eq(schema.trackedTraders.name, name));
  refresh();
}

export async function setNotes(name: string, notes: string | null) {
  if (!name) return;
  await db
    .update(schema.trackedTraders)
    .set({ notes: notes || null })
    .where(eq(schema.trackedTraders.name, name));
  refresh();
}

export async function setRiskPercent(name: string, riskPercent: number | null) {
  if (!name) return;
  if (riskPercent == null) {
    await db
      .update(schema.trackedTraders)
      .set({ positionSizingConfig: null })
      .where(eq(schema.trackedTraders.name, name));
  } else {
    // Read existing config to preserve ATR params if previously set
    const [trader] = await db
      .select({ positionSizingConfig: schema.trackedTraders.positionSizingConfig })
      .from(schema.trackedTraders)
      .where(eq(schema.trackedTraders.name, name));
    const existing = trader?.positionSizingConfig;
    await db
      .update(schema.trackedTraders)
      .set({
        positionSizingConfig: {
          strategy: 'atr' as const,
          riskPercent,
          atrMultiplier: existing?.atrMultiplier ?? 2.0,
          atrPeriod: existing?.atrPeriod ?? 14,
        },
      })
      .where(eq(schema.trackedTraders.name, name));
  }
  refresh();
}

export async function bulkAdd(names: string[]) {
  const valid = names.map((n) => n.trim()).filter(Boolean);
  if (!valid.length) return;
  await db.insert(schema.trackedTraders).values(
    valid.map((name) => ({
      name,
      enabled: true,
      strategies: DEFAULT_STRATEGIES,
      notes: null,
    })),
  );
  refresh();
}

export async function bulkRemove(names: string[]) {
  if (!names.length) return;
  await db
    .delete(schema.trackedTraders)
    .where(inArray(schema.trackedTraders.name, names));
  refresh();
}

export async function bulkToggleStrategy(
  names: string[],
  strategy: string,
  enable: boolean,
) {
  if (!names.length) return;
  const traders = await db
    .select()
    .from(schema.trackedTraders)
    .where(inArray(schema.trackedTraders.name, names));
  for (const trader of traders) {
    const current = trader.strategies;
    const next = enable
      ? current.includes(strategy)
        ? current
        : [...current, strategy]
      : current.filter((s) => s !== strategy);
    if (next.length !== current.length || !next.every((s) => current.includes(s))) {
      await db
        .update(schema.trackedTraders)
        .set({ strategies: next })
        .where(eq(schema.trackedTraders.name, trader.name));
    }
  }
  refresh();
}
