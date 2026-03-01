/**
 * Signal Event Emitter — one function, one insert.
 *
 * Every meaningful state change in the signal lifecycle gets its own row
 * in run_decisions. The SETTLED event is the final event, carrying the
 * outcome (EXECUTE/SKIP/FAIL). Intermediate events have null outcome.
 *
 * See docs/plans/decision-events.md for the full event catalog.
 */

import { db, schema } from '../db/client.js';

export type EmitOpts = {
  signalIndex?: number | null;
  outcome?: string | null;
  phase?: string | null;
  reasoning?: string | null;
  skipCategory?: string | null;
  tradeId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

export type SignalEventEmitter = {
  emit: (event: string, payload?: Record<string, unknown>, opts?: EmitOpts) => Promise<void>;
};

export function createEmitter(scope: {
  messageId: string;
  backtestRunId?: string;
  taskId?: string;
}): SignalEventEmitter {
  const startMs = Date.now();
  return {
    emit: async (event, payload, opts) => {
      await db.insert(schema.runDecisions).values({
        messageId: scope.messageId,
        backtestRunId: scope.backtestRunId ?? null,
        taskId: scope.taskId ?? null,
        event,
        signalIndex: opts?.signalIndex ?? null,
        outcome: opts?.outcome ?? null,
        phase: opts?.phase ?? null,
        reasoning: opts?.reasoning ?? null,
        tradeId: opts?.tradeId ?? null,
        skipCategory: opts?.skipCategory ?? null,
        snapshot: payload ?? {},
        durationMs: Date.now() - startMs,
        inputTokens: opts?.inputTokens ?? null,
        outputTokens: opts?.outputTokens ?? null,
      });
    },
  };
}
