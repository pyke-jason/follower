import { Hono } from 'hono';
import type { BrokerService } from '../../broker/interface.js';
import { recordTrade } from '../../trades/record-trade.js';

export function createTradesRouter(broker: BrokerService) {
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

    const orderResult = await broker.placeOrder({
      symbol: body.symbol,
      strategy: body.strategy,
      direction: body.direction,
      legs: body.legs,
      orderType: 'MARKET' as const,
      isClosing: true,
    });

    // Record the close through the canonical write path (emits trade_events).
    const recorded = await recordTrade({
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

  return app;
}
