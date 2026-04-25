import { Hono } from 'hono';
import type { BrokerService } from '@/broker/interface.js';
import type { BrokerPosition } from '@/broker/types.js';
import { isHalted, readHaltState, setHalt, clearHalt } from '@/lib/halt-state.js';
import { sendSystemAlert } from '@/lib/alert.js';

async function closeBrokerPositions(broker: BrokerService): Promise<{ symbol: string; ok: boolean; error?: string }[]> {
  const positions = await broker.getPositions();
  const open = positions.filter((p) => p.quantity !== 0);
  const results: { symbol: string; ok: boolean; error?: string }[] = [];

  for (const pos of open) {
    try {
      await closePosition(broker, pos);
      results.push({ symbol: pos.symbol, ok: true });
    } catch (err) {
      results.push({ symbol: pos.symbol, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

async function closePosition(broker: BrokerService, pos: BrokerPosition): Promise<void> {
  const isLong = pos.quantity > 0;
  const action = isLong ? 'SELL' : 'BUY';
  const quantity = Math.abs(pos.quantity);

  if (pos.assetType === 'EQ') {
    await broker.placeOrder({
      symbol: pos.symbol,
      strategy: 'STOCK',
      direction: isLong ? 'SHORT' : 'LONG',
      legs: [{ symbol: pos.symbol, type: 'STOCK', action, quantity, strike: 0, expiry: '' }],
      orderType: 'MARKET',
      isClosing: true,
    });
    return;
  }

  // Option position — derive underlying from the IBKR local symbol (e.g. "AAPL 240119C00150000")
  const underlying = pos.symbol.split(' ')[0] ?? pos.symbol;
  const optionType = pos.optionType === 'CALL' ? 'CALL' : 'PUT';
  if (!pos.expiry || pos.strikePrice == null) {
    throw new Error(`Cannot close option position ${pos.symbol}: missing expiry or strike`);
  }
  await broker.placeOrder({
    symbol: underlying,
    strategy: optionType,
    direction: isLong ? 'SHORT' : 'LONG',
    legs: [{
      symbol: pos.symbol,
      type: optionType,
      action,
      quantity,
      expiry: pos.expiry,
      strike: pos.strikePrice,
    }],
    orderType: 'MARKET',
    isClosing: true,
  });
}

export function createAdminRouter(channelBrokers: Map<string, BrokerService>) {
  const app = new Hono();

  app.get('/halt', (c) => {
    const state = readHaltState();
    return c.json({ halted: state !== null, state: state ?? null });
  });

  app.post('/halt', async (c) => {
    const raw = await c.req.json<{ reason?: string; closeAll?: boolean }>().catch(() => ({})) as { reason?: string; closeAll?: boolean };
    const reason = raw.reason ?? 'Halt triggered via API';
    const closeAll = raw.closeAll === true;

    const haltState = setHalt(reason, 'api');

    const cancelResults: Array<{ channelId: string; ok: boolean; error?: string }> = [];
    for (const [channelId, broker] of channelBrokers) {
      try {
        await broker.cancelAllOrders();
        cancelResults.push({ channelId, ok: true });
      } catch (err) {
        cancelResults.push({ channelId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const closeResults: Array<{ channelId: string; ok: boolean; closed?: number; results?: unknown; error?: string }> = [];
    if (closeAll) {
      for (const [channelId, broker] of channelBrokers) {
        try {
          const results = await closeBrokerPositions(broker);
          closeResults.push({ channelId, ok: true, closed: results.filter((r) => r.ok).length, results });
        } catch (err) {
          closeResults.push({ channelId, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    await sendSystemAlert({
      title: 'TRADING HALTED — Kill switch activated',
      message: reason,
      severity: 'critical',
      fields: [
        { name: 'Triggered By', value: 'API', inline: true },
        { name: 'Time', value: haltState.haltedAt, inline: true },
        { name: 'Close Positions', value: closeAll ? 'YES' : 'No', inline: true },
      ],
    });

    return c.json({ ok: true, haltState, cancelResults, closeResults });
  });

  app.delete('/halt', async (c) => {
    if (!isHalted()) {
      return c.json({ ok: true, message: 'Trading was not halted' });
    }
    clearHalt();
    await sendSystemAlert({
      title: 'Trading Resumed',
      message: 'Kill switch cleared via API. Trading will resume on next signal.',
      severity: 'info',
    });
    return c.json({ ok: true, message: 'Trading resumed' });
  });

  return app;
}
