/**
 * Kill switch CLI — immediately halts trading and cancels working IBKR orders.
 *
 * Usage:
 *   pnpm halt                          # halt, preserve positions
 *   pnpm halt --close-all              # halt + market-close all open positions
 *   pnpm halt --reason "Stop-loss hit" # halt with a custom reason
 */

import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { isHalted, setHalt } from '../lib/halt-state.js';
import { getRuntimeBrokerMap } from '../broker/select.js';
import { sendSystemAlert } from '../lib/alert.js';
import type { BrokerPosition } from '../broker/types.js';
import type { BrokerService } from '../broker/interface.js';

function parseArgs() {
  const args = process.argv.slice(2);
  let reason = 'Manual halt via CLI';
  let closeAll = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--close-all') closeAll = true;
    if (args[i] === '--reason' && args[i + 1]) { reason = args[++i]!; }
  }
  return { reason, closeAll };
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

async function main() {
  const { reason, closeAll } = parseArgs();

  if (isHalted()) {
    console.log('[halt] Trading is already halted. Use `pnpm resume` to clear first.');
    process.exit(0);
  }

  // Set halt flag FIRST — stops the running bot from placing any new orders
  const haltState = setHalt(reason, 'cli');
  console.error(`\n[HALT] Kill switch ACTIVATED at ${haltState.haltedAt}`);
  console.error(`[HALT] Reason: ${haltState.reason}\n`);

  const brokerMap = getRuntimeBrokerMap();
  if (brokerMap.size === 0) {
    console.warn('[halt] No runtime broker channels found — flag set, but no orders to cancel.');
    process.exit(0);
  }

  // Cancel all working IBKR orders
  for (const [channelId, broker] of brokerMap) {
    console.log(`[halt] Cancelling all working orders for channel ${channelId}...`);
    try {
      await broker.cancelAllOrders();
      console.log(`[halt] ✓ Global cancel sent to ${channelId}`);
    } catch (err) {
      console.error(`[halt] ✗ cancelAllOrders failed for ${channelId}:`, err);
    }
  }

  // Optionally close all positions at market
  if (closeAll) {
    console.log('[halt] --close-all: sending market close orders for all open positions...');
    for (const [channelId, broker] of brokerMap) {
      try {
        const positions = await broker.getPositions();
        const open = positions.filter((p) => p.quantity !== 0);
        if (open.length === 0) {
          console.log(`[halt] ${channelId}: no open positions`);
          continue;
        }
        for (const pos of open) {
          try {
            await closePosition(broker, pos);
            console.log(`[halt] ✓ Market close sent for ${pos.symbol} (qty ${pos.quantity})`);
          } catch (err) {
            console.error(`[halt] ✗ Failed to close ${pos.symbol}:`, err);
          }
        }
      } catch (err) {
        console.error(`[halt] ✗ getPositions failed for ${channelId}:`, err);
      }
    }
  }

  await sendSystemAlert({
    title: 'TRADING HALTED — Kill switch activated',
    message: reason,
    severity: 'critical',
    fields: [
      { name: 'Triggered By', value: 'CLI', inline: true },
      { name: 'Time', value: haltState.haltedAt, inline: true },
      { name: 'Close Positions', value: closeAll ? 'YES' : 'No', inline: true },
    ],
  });

  console.log('\n[halt] Done. Bot will refuse new orders on next signal.');
  console.log('[halt] To resume: pnpm resume\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('[halt] Fatal error:', err);
  process.exit(1);
});
