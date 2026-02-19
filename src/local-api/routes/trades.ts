import { Hono } from 'hono';
import { placeOrder } from '../../broker/tradestation.js';

const app = new Hono();

app.post('/force-exit', async (c) => {
  const body = await c.req.json<{
    symbol: string;
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

  const result = await placeOrder({
    symbol: body.symbol,
    strategy: body.strategy,
    direction: body.direction,
    legs: body.legs,
    orderType: 'MARKET' as const,
  });

  return c.json({
    orderId: result.orderId,
    status: result.status,
    filledPrice: result.filledPrice,
  });
});

export default app;
