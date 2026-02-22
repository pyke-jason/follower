import { Hono } from 'hono';
import { placeOrder } from '../../broker/tradestation.js';
import { recordTrade } from '../../trades/record-trade.js';

const app = new Hono();

app.post('/force-exit', async (c) => {
  const body = await c.req.json<{
    tradeId: string;
    symbol: string;
    trader: string;
    strategy: string;
    direction: 'LONG' | 'SHORT';
    legs: Array<{
      symbol: string;
      type: 'CALL' | 'PUT' | 'STOCK';
      action: 'BUY' | 'SELL';
      quantity: number;
      expiry: string;
      strike: number;
    }>;
  }>();

  let orderResult;
  try {
    orderResult = await placeOrder({
      symbol: body.symbol,
      strategy: body.strategy,
      direction: body.direction,
      legs: body.legs,
      orderType: 'MARKET' as const,
    });
  } catch (err) {
    return c.json({ error: `Force-exit order failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }

  if (orderResult.filledPrice == null) {
    throw new Error('Force-exit failed: broker did not return filledPrice');
  }

  // Record the close through the canonical write path (emits trade_events).
  const recorded = await recordTrade({
    action: 'CLOSE',
    tradeId: body.tradeId,
    symbol: body.symbol,
    trader: body.trader,
    exitPrice: orderResult.filledPrice,
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
