import { Hono } from 'hono';
import { z } from 'zod';
import { placeOrder } from '../../broker/tradestation.js';
import { recordTrade } from '../../trades/record-trade.js';
import { sendSystemAlert } from '../../lib/alert.js';
import { DirectionSchema, StrategySchema } from '../../lib/enums.js';
import { OrderResultSchema } from '../../broker/order-schemas.js';

const ForceExitBodySchema = z.object({
  tradeId: z.string().min(1),
  symbol: z.string().min(1),
  trader: z.string().min(1),
  strategy: StrategySchema,
  direction: DirectionSchema,
  legs: z.array(z.object({
    symbol: z.string(),
    type: z.enum(['CALL', 'PUT', 'STOCK']),
    action: z.enum(['BUY', 'SELL']),
    quantity: z.number().int().positive(),
    expiry: z.string(),
    strike: z.number().nonnegative(),
  })),
});

const app = new Hono();

app.post('/force-exit', async (c) => {
  const body = ForceExitBodySchema.parse(await c.req.json());

  let orderResult;
  try {
    orderResult = OrderResultSchema.parse(await placeOrder({
      symbol: body.symbol,
      strategy: body.strategy,
      direction: body.direction,
      legs: body.legs,
      orderType: 'MARKET' as const,
    }));
  } catch (err) {
    const message = `Force-exit order failed for ${body.symbol} [${body.tradeId.slice(0, 8)}]: ${err instanceof Error ? err.message : String(err)}`;
    sendSystemAlert({ title: 'Force-exit failed', message, severity: 'critical' });
    throw new Error(message);
  }

  if (orderResult.status !== 'FILLED') {
    const message = `Force-exit order not filled for ${body.symbol} [${body.tradeId.slice(0, 8)}]: status=${orderResult.status}`;
    sendSystemAlert({ title: 'Force-exit not filled', message, severity: 'critical' });
    throw new Error(message);
  }

  // OrderResultSchema.refine() guarantees filledPrice exists for FILLED orders
  const recorded = await recordTrade({
    action: 'CLOSE',
    tradeId: body.tradeId,
    symbol: body.symbol,
    trader: body.trader,
    direction: body.direction,
    strategy: body.strategy,
    exitPrice: orderResult.filledPrice!,
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
