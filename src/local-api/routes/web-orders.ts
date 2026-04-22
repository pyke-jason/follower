import { Hono } from 'hono';
import type { BrokerService } from '@/broker/interface.js';
import { OrderResultSchema } from '@/broker/order-schemas.js';
import { db, schema } from '@/db/client.js';
import type { TradeLeg } from '@/db/schema.js';
import { tradeQty } from '@/lib/trade.js';
import { eq } from 'drizzle-orm';
import { recordTrade } from '@/trades/record-trade.js';
import {
  ModifyOrderBodySchema,
  OrderIdParamsSchema,
  PlaceOrderBodySchema,
  QuoteDataSchema,
  toQuoteData,
  WorkingOrderResponseSchema,
  type WorkingOrderResponse,
} from '../http-schemas.js';
import {
  findActiveManualOrderForTrade,
  getManualOrder,
  markManualOrderTradeRecorded,
  type StoredManualOrder,
  toWorkingOrderResponse,
  upsertManualOrder,
} from '../manual-order-store.js';
import { validateBody, validateParams } from '../validate.js';

function normalizeOrderLegs(legs: TradeLeg[]): WorkingOrderResponse['legs'] {
  return legs.map(({ symbol, type, action, quantity, expiry, strike }) => ({
    symbol,
    type,
    action,
    quantity,
    expiry,
    strike,
  }));
}

function scaleExitLegs(legs: TradeLeg[], totalTradeQuantity: number, requestedQuantity: number): TradeLeg[] {
  return legs.map((leg) => {
    const scaled = (leg.quantity * requestedQuantity) / totalTradeQuantity;
    if (!Number.isInteger(scaled) || scaled <= 0) {
      throw new Error(
        `Cannot scale leg quantity ${leg.quantity} from trade quantity ${totalTradeQuantity} to ${requestedQuantity}`,
      );
    }
    return { ...leg, quantity: scaled };
  });
}

function mergeOrderResult(existing: StoredManualOrder, rawResult: unknown): StoredManualOrder {
  const result = OrderResultSchema.parse(rawResult);
  const next = {
    ...existing,
    status: result.status,
    message: result.message,
    filledPrice: result.status === 'FILLED' ? result.filledPrice : existing.filledPrice,
    filledQuantity:
      result.status === 'FILLED'
        ? (result.filledQuantity ?? existing.quantity)
        : existing.filledQuantity,
    commission: result.status === 'FILLED' ? result.commission : existing.commission,
    filledAt: result.status === 'FILLED' ? result.fillTimestamp : existing.filledAt,
    cancelledAt:
      result.status === 'CANCELLED' || result.status === 'REJECTED'
        ? existing.cancelledAt ?? new Date().toISOString()
        : existing.cancelledAt,
  };
  return next;
}

async function recordFilledExitIfNeeded(orderId: string): Promise<void> {
  const order = getManualOrder(orderId);
  if (!order || order.status !== 'FILLED' || order.tradeRecordedAt) return;

  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, order.tradeId))
    .limit(1);

  if (!trade || trade.status !== 'OPEN') {
    markManualOrderTradeRecorded(orderId);
    return;
  }

  const filledQuantity = order.filledQuantity ?? order.quantity;
  const totalTradeQuantity = tradeQty(trade.quantity);
  const action = filledQuantity >= totalTradeQuantity ? 'CLOSE' as const : 'TRIM' as const;

  await recordTrade({
    action,
    tradeId: trade.id,
    symbol: trade.symbol,
    trader: trade.trader,
    exitPrice: order.filledPrice ?? 0,
    closedAt: order.filledAt ?? new Date().toISOString(),
    channelId: order.channelId,
    ...(action === 'TRIM' && { closeQuantity: filledQuantity }),
    metadata: {
      extra: {
        manualExitOrderId: order.orderId,
      },
    },
  });

  markManualOrderTradeRecorded(orderId);
}

export function createWebOrdersRouter(channelBrokers: Map<string, BrokerService>) {
  const app = new Hono();

  app.get('/quotes/:symbol', async (c) => {
    const symbol = c.req.param('symbol');
    const channelId = c.req.query('channel');
    if (!channelId) {
      return c.json({ error: 'channel query param is required' }, 400);
    }

    const broker = channelBrokers.get(channelId);
    if (!broker) {
      return c.json({ error: `Unknown channelId "${channelId}"` }, 400);
    }

    const raw = await broker.getQuote(symbol);
    return c.json(QuoteDataSchema.parse(toQuoteData(raw)));
  });

  app.post('/orders', async (c) => {
    const body = await validateBody(PlaceOrderBodySchema, c);

    const broker = channelBrokers.get(body.channelId);
    if (!broker) {
      return c.json({ error: `Unknown channelId "${body.channelId}"` }, 400);
    }

    const existingOrder = findActiveManualOrderForTrade(body.tradeId);
    if (existingOrder) {
      return c.json(toWorkingOrderResponse(existingOrder));
    }

    const [trade] = await db
      .select()
      .from(schema.trades)
      .where(eq(schema.trades.id, body.tradeId))
      .limit(1);

    if (!trade) {
      return c.json({ error: `Trade ${body.tradeId} not found` }, 404);
    }
    if (trade.channelId !== body.channelId) {
      return c.json(
        { error: `Trade ${body.tradeId} belongs to ${trade.channelId}, not ${body.channelId}` },
        400,
      );
    }
    if (trade.status !== 'OPEN') {
      return c.json({ error: `Trade ${body.tradeId} is not open` }, 400);
    }

    const totalTradeQuantity = tradeQty(trade.quantity);
    if (body.quantity > totalTradeQuantity) {
      return c.json(
        { error: `Requested quantity ${body.quantity} exceeds open quantity ${totalTradeQuantity}` },
        400,
      );
    }

    let scaledLegs: TradeLeg[];
    try {
      scaledLegs = scaleExitLegs(trade.legs, totalTradeQuantity, body.quantity);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Unable to scale trade legs' },
        400,
      );
    }

    const placedAt = new Date().toISOString();
    const rawResult = await broker.placeOrder({
      symbol: trade.symbol,
      strategy: trade.strategy,
      direction: trade.direction,
      legs: normalizeOrderLegs(scaledLegs),
      orderType: body.orderType,
      limitPrice: body.orderType === 'LIMIT' ? body.limitPrice : undefined,
      isClosing: true,
    });
    const result = OrderResultSchema.parse(rawResult);

    const order = upsertManualOrder({
      orderId: result.orderId,
      tradeId: trade.id,
      channelId: trade.channelId,
      trader: trade.trader,
      status: result.status,
      orderType: body.orderType,
      symbol: trade.symbol,
      strategy: trade.strategy,
      direction: trade.direction,
      legs: normalizeOrderLegs(scaledLegs),
      quantity: body.quantity,
      limitPrice: body.orderType === 'LIMIT' ? body.limitPrice : undefined,
      currentLimitPrice: body.orderType === 'LIMIT' ? body.limitPrice : undefined,
      filledPrice: result.filledPrice,
      filledQuantity: result.filledQuantity ?? (result.status === 'FILLED' ? body.quantity : undefined),
      commission: result.commission,
      placedAt,
      filledAt: result.fillTimestamp,
      cancelledAt:
        result.status === 'CANCELLED' || result.status === 'REJECTED' ? placedAt : undefined,
      message: result.message,
    });

    if (order.status === 'FILLED') {
      await recordFilledExitIfNeeded(order.orderId);
    }

    return c.json(WorkingOrderResponseSchema.parse(toWorkingOrderResponse(order)));
  });

  app.get('/orders/:id', async (c) => {
    const { id } = validateParams(OrderIdParamsSchema, c);
    const order = getManualOrder(id);
    if (!order) {
      return c.json({ error: `Order ${id} not found` }, 404);
    }

    if (order.status === 'OPEN' || order.status === 'PENDING') {
      const broker = channelBrokers.get(order.channelId);
      if (!broker) {
        return c.json({ error: `Unknown channelId "${order.channelId}"` }, 400);
      }
      const synced = upsertManualOrder(mergeOrderResult(order, await broker.getOrderStatus(order.orderId)));
      if (synced.status === 'FILLED') {
        await recordFilledExitIfNeeded(synced.orderId);
      }
      return c.json(WorkingOrderResponseSchema.parse(toWorkingOrderResponse(synced)));
    }

    return c.json(WorkingOrderResponseSchema.parse(toWorkingOrderResponse(order)));
  });

  app.put('/orders/:id', async (c) => {
    const { id } = validateParams(OrderIdParamsSchema, c);
    const body = await validateBody(ModifyOrderBodySchema, c);
    const order = getManualOrder(id);
    if (!order) {
      return c.json({ error: `Order ${id} not found` }, 404);
    }
    if (order.orderType !== 'LIMIT') {
      return c.json({ error: 'Only LIMIT orders can be modified' }, 400);
    }
    if (order.status === 'FILLED' || order.status === 'CANCELLED' || order.status === 'REJECTED') {
      return c.json({ error: `Order ${id} is already ${order.status}` }, 400);
    }

    const broker = channelBrokers.get(order.channelId);
    if (!broker) {
      return c.json({ error: `Unknown channelId "${order.channelId}"` }, 400);
    }

    const rawResult = await broker.modifyOrder(id, body.limitPrice);
    const synced = upsertManualOrder({
      ...mergeOrderResult(order, rawResult),
      currentLimitPrice: body.limitPrice,
    });
    if (synced.status === 'FILLED') {
      await recordFilledExitIfNeeded(synced.orderId);
    }
    return c.json(WorkingOrderResponseSchema.parse(toWorkingOrderResponse(synced)));
  });

  app.delete('/orders/:id', async (c) => {
    const { id } = validateParams(OrderIdParamsSchema, c);
    const order = getManualOrder(id);
    if (!order) {
      return c.json({ error: `Order ${id} not found` }, 404);
    }
    if (order.status === 'FILLED' || order.status === 'CANCELLED' || order.status === 'REJECTED') {
      return c.json(WorkingOrderResponseSchema.parse(toWorkingOrderResponse(order)));
    }

    const broker = channelBrokers.get(order.channelId);
    if (!broker) {
      return c.json({ error: `Unknown channelId "${order.channelId}"` }, 400);
    }

    const rawResult = await broker.cancelOrder(id);
    const synced = upsertManualOrder(mergeOrderResult(order, rawResult));
    return c.json(WorkingOrderResponseSchema.parse(toWorkingOrderResponse(synced)));
  });

  return app;
}
