/**
 * Signal Event Emitter — typed columns + opaque snapshot.
 *
 * `columns` = the standard fields every decision can carry (indexed, queryable).
 * `snapshot` = the raw event blob for debugging (order objects, signal data, etc.).
 */

import { db, schema, withDbRetry } from '../db/client.js';
import type { RunDecision } from '../db/schema.js';

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
  onDecision?: (decision: RunDecision) => void | Promise<void>;
}): SignalEventEmitter {
  const { onDecision, ...insertScope } = scope;
  const startMs = Date.now();
  return {
    emit: async (event, columns = {}, snapshot) => {
      const [decision] = await withDbRetry(() =>
        db.insert(schema.runDecisions).values({
          ...insertScope,
          ...columns,
          event,
          snapshot: snapshot ?? null,
          durationMs: Date.now() - startMs,
        }).returning(),
      );
      if (decision && onDecision) {
        void Promise.resolve(onDecision(decision)).catch((err) => {
          console.warn('[DecisionEmitter] onDecision failed:', err);
        });
      }
    },
  };
}
