import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import type { TaskResult, TradeMetadata } from '../db/schema.js';
import type { OrderResult } from '../broker/types.js';

export async function recordStep(
  taskId: string,
  stepNumber: number,
  step: {
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: unknown;
    reasoning?: string;
    durationMs?: number;
  }
): Promise<void> {
  await db.insert(schema.taskSteps).values({
    taskId,
    stepNumber,
    toolName: step.toolName ?? null,
    toolInput: step.toolInput ?? null,
    toolOutput: step.toolOutput ?? null,
    reasoning: step.reasoning ?? null,
    durationMs: step.durationMs ?? null,
  });
}

export async function completeTask(
  taskId: string,
  result: TaskResult
): Promise<void> {
  await db.update(schema.tasks)
    .set({
      status: 'COMPLETED',
      result,
      completedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.id, taskId));
}

export async function failTask(
  taskId: string,
  error: string
): Promise<void> {
  await db.update(schema.tasks)
    .set({
      status: 'FAILED',
      error,
      completedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.id, taskId));
}

export async function startTask(taskId: string): Promise<void> {
  await db.update(schema.tasks)
    .set({
      status: 'IN_PROGRESS',
      startedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.id, taskId));
}

/**
 * Enrich a trade record with broker fill data.
 * Computes slippage between requested entry price and actual broker fill price.
 */
export async function enrichTradeWithFill(
  tradeId: string,
  fillData: OrderResult,
): Promise<void> {
  const [trade] = await db.select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId))
    .limit(1);

  if (!trade) return;

  const metadata = (trade.metadata ?? {}) as TradeMetadata;

  // Compute slippage if we have both entry and fill prices
  let slippage: number | undefined;
  if (trade.entryPrice && fillData.filledPrice != null) {
    const entry = parseFloat(trade.entryPrice);
    if (!isNaN(entry)) {
      slippage = Math.round((fillData.filledPrice - entry) * 100) / 100;
    }
  }

  await db.update(schema.trades)
    .set({
      brokerFillPrice: fillData.filledPrice != null ? String(fillData.filledPrice) : null,
      brokerFillQty: fillData.filledQuantity ?? null,
      brokerCommission: fillData.commission != null ? String(fillData.commission) : null,
      brokerFillTime: fillData.fillTimestamp ?? null,
      brokerLegFills: fillData.legFills ?? null,
      metadata: {
        ...metadata,
        slippage: slippage ?? metadata.slippage,
        fillEnriched: true,
        fillEnrichedAt: new Date().toISOString(),
      },
    })
    .where(eq(schema.trades.id, tradeId));
}
