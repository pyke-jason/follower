import { Hono } from 'hono';
import type { Direction, LegAction } from '@/lib/enums.js';
import type { BrokerService } from '@/broker/interface.js';
import { db, schema } from '@/db/client.js';
import { eq } from 'drizzle-orm';
import { recordTrade } from '@/trades/record-trade.js';

export function createTradesRouter(channelBrokers: Map<string, BrokerService>) {
  const app = new Hono();

  app.post('/force-exit', async (c) => {
    const body = await c.req.json<{
      channelId: string;
      tradeId: string;
      symbol: string;
      trader: string;
      strategy: string;
      direction: Direction;
      legs: Array<{
        symbol: string;
        type: 'CALL' | 'PUT' | 'STOCK';
        action: LegAction;
        quantity: number;
        expiry: string;
        strike: number;
      }>;
    }>();

    const broker = channelBrokers.get(body.channelId);
    if (!broker) {
      return c.json({ error: `Unknown channelId "${body.channelId}"` }, 400);
    }

    const [trade] = await db
      .select({ channelId: schema.trades.channelId })
      .from(schema.trades)
      .where(eq(schema.trades.id, body.tradeId))
      .limit(1);
    if (!trade) {
      return c.json({ error: `Trade ${body.tradeId} not found` }, 404);
    }
    if (trade.channelId !== body.channelId) {
      return c.json(
        {
          error: `Trade ${body.tradeId} belongs to ${trade.channelId}, not ${body.channelId}`,
        },
        400,
      );
    }

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
      channelId: body.channelId,
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
