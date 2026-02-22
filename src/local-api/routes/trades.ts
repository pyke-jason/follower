import { Hono } from 'hono';
import { z } from 'zod';
import { placeOrder } from '../../broker/tradestation.js';
import { recordTrade } from '../../trades/record-trade.js';
import { DirectionSchema, StrategySchema } from '../../lib/enums.js';
import { TradeLegSchema } from '../../db/schema.js';

const ForceExitRequestSchema = z.object({
  tradeId: z.string().uuid(),
  symbol: z.string().min(1),
  trader: z.string().min(1),
  strategy: StrategySchema,
  direction: DirectionSchema,
  legs: z.array(TradeLegSchema.omit({ fillPrice: true })),
});

const app = new Hono();

app.post('/force-exit', async (c) => {
  let body: z.infer<typeof ForceExitRequestSchema>;
  try {
    body = ForceExitRequestSchema.parse(await c.req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return c.json({ error: 'Invalid request body', details: e.errors }, 400);
    }
    throw e;
  }

  const orderResult = await placeOrder({
    symbol: body.symbol,
    strategy: body.strategy,
    direction: body.direction,
    legs: body.legs,
    orderType: 'MARKET' as const,
  });

  // Record the close through the canonical write path (emits trade_events).
  const recorded = await recordTrade({
    action: 'CLOSE',
    tradeId: body.tradeId,
    symbol: body.symbol,
    trader: body.trader,
    exitPrice: orderResult.filledPrice ?? 0,
    closedAt: new Date().toISOString(),
    metadata: {
      forceExit: true,
      forceExitOrderId: orderResult.orderId,
      forceExitStatus: orderResult.status,
    },
  });

  return c.json({
    orderId: orderResult.orderId,
    status: orderResult.status,
    filledPrice: orderResult.filledPrice,
    tradeId: recorded?.tradeId ?? body.tradeId,
  });
});

export default app;
