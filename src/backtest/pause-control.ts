import { eq } from 'drizzle-orm';
import { db, schema, withDbRetry } from '../db/client.js';
import { createLogger } from '../lib/logger.js';
import type { DependencyUnavailableError } from '../lib/errors.js';

const log = createLogger('BacktestPause');
const PAUSE_POLL_MS = 1_000;

type BacktestRunState = {
  status: string;
  error: string | null;
};

export type BacktestPauseControl = {
  waitIfPaused: () => Promise<void>;
  pauseForDependency: (err: DependencyUnavailableError) => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRunState(runId: string): Promise<BacktestRunState | null> {
  const [run] = await db
    .select({
      status: schema.backtestRuns.status,
      error: schema.backtestRuns.error,
    })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, runId));
  return run ?? null;
}

function formatPauseReason(err: DependencyUnavailableError): string {
  return `Paused: waiting for ${err.dependency} availability. ${err.message}`;
}

export function createBacktestPauseControl(runId: string): BacktestPauseControl {
  let lastPauseReason: string | null = null;

  const waitIfPaused = async (): Promise<void> => {
    while (true) {
      const run = await readRunState(runId);
      if (!run) throw new Error(`Backtest ${runId} not found`);

      if (run.status === 'RUNNING' || run.status === 'PENDING') {
        if (lastPauseReason) {
          log.info(`Resumed ${runId}`);
          lastPauseReason = null;
        }
        return;
      }

      if (run.status === 'PAUSED') {
        const reason = run.error ?? 'Paused';
        if (reason !== lastPauseReason) {
          log.warn(`${runId}: ${reason}`);
          lastPauseReason = reason;
        }
        await sleep(PAUSE_POLL_MS);
        continue;
      }

      if (run.status === 'CANCELLED') {
        throw new Error(`Backtest ${runId} cancelled`);
      }

      throw new Error(`Backtest ${runId} is ${run.status.toLowerCase()}`);
    }
  };

  const pauseForDependency = async (err: DependencyUnavailableError): Promise<void> => {
    const run = await readRunState(runId);
    if (!run) throw new Error(`Backtest ${runId} not found`);
    if (run.status === 'CANCELLED') throw new Error(`Backtest ${runId} cancelled`);
    if (run.status === 'FAILED' || run.status === 'COMPLETED') {
      throw new Error(`Backtest ${runId} is ${run.status.toLowerCase()}`);
    }

    const reason = formatPauseReason(err);
    if (run.status !== 'PAUSED' || run.error !== reason) {
      await withDbRetry(() =>
        db.update(schema.backtestRuns)
          .set({ status: 'PAUSED', error: reason })
          .where(eq(schema.backtestRuns.id, runId))
      );
    }

    lastPauseReason = reason;
    await waitIfPaused();
  };

  return { waitIfPaused, pauseForDependency };
}
