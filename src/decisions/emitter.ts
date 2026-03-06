/**
 * Signal Event Emitter — typed columns + opaque snapshot.
 *
 * `columns` = the standard fields every decision can carry (indexed, queryable).
 * `snapshot` = the raw event blob for debugging (order objects, signal data, etc.).
 */

import { db, schema, withBusyRetry } from '../db/client.js';

export type DecisionColumns = {
  signalIndex?: number;
  outcome?: string;
  phase?: string;
  reasoning?: string;
  skipCategory?: string;
  tradeId?: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type SignalEventEmitter = {
  emit: (event: string, columns?: DecisionColumns, snapshot?: Record<string, unknown>) => Promise<void>;
};

export function createEmitter(scope: {
  messageId?: string;
  channelId: string;
  taskId?: string;
}): SignalEventEmitter {
  const startMs = Date.now();
  return {
    emit: async (event, columns = {}, snapshot) => {
      await withBusyRetry(() =>
        db.insert(schema.runDecisions).values({
          ...scope,
          ...columns,
          event,
          snapshot: snapshot ?? null,
          durationMs: Date.now() - startMs,
        }),
      );
    },
  };
}
