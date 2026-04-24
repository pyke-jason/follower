import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { BacktestCheckpointState } from './checkpoint-types.js';

export async function loadBacktestCheckpoint(runId: string): Promise<BacktestCheckpointState | null> {
  const [row] = await db
    .select({ state: schema.backtestCheckpoints.state })
    .from(schema.backtestCheckpoints)
    .where(eq(schema.backtestCheckpoints.runId, runId));
  return row?.state ?? null;
}

export async function hasBacktestCheckpoint(runId: string): Promise<boolean> {
  const [row] = await db
    .select({ runId: schema.backtestCheckpoints.runId })
    .from(schema.backtestCheckpoints)
    .where(eq(schema.backtestCheckpoints.runId, runId));
  return row != null;
}

export async function saveBacktestCheckpoint(state: BacktestCheckpointState): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(schema.backtestCheckpoints)
    .values({
      runId: state.runId,
      state: { ...state, updatedAt: now },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.backtestCheckpoints.runId,
      set: {
        state: { ...state, updatedAt: now },
        updatedAt: now,
      },
    });
}
