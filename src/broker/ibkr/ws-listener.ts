/**
 * WebSocket listener for IBKR sidecar events.
 *
 * Supplementary to OrderManager's polling — provides faster fill notification
 * and connection state alerts. NOT required for correctness.
 */

import { WebSocket } from 'ws';
import { SidecarEventSchema } from './schemas.js';
import { sendSystemAlert } from '../../lib/alert.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('IBKR-WS');

const SIDECAR_WS = process.env.IBKR_SIDECAR_WS ?? 'ws://localhost:8090/events';
const RECONNECT_DELAY_MS = 5_000;

type ForceCheckFn = (orderId: number) => void;

let ws: WebSocket | null = null;
let shouldReconnect = true;
let forceCheckCallback: ForceCheckFn | undefined;

function connect(): void {
  if (ws) return;

  log.info(`Connecting to sidecar WebSocket at ${SIDECAR_WS}`);
  ws = new WebSocket(SIDECAR_WS);

  ws.on('open', () => {
    log.info('Sidecar WebSocket connected');
  });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(String(raw));
      const result = SidecarEventSchema.safeParse(data);
      if (!result.success) {
        log.debug(`Ignoring unrecognized sidecar event: ${String(raw).slice(0, 200)}`);
        return;
      }

      const event = result.data;

      switch (event.type) {
        case 'connected':
          log.debug('Sidecar reports TWS connected');
          break;

        case 'disconnected':
          sendSystemAlert({
            severity: 'warning',
            title: 'IBKR sidecar disconnected',
            message: 'The IBKR sidecar lost connection to IB Gateway. Orders will fail until reconnected.',
          });
          break;

        case 'reconnected':
          sendSystemAlert({
            severity: 'info',
            title: 'IBKR Gateway reconnected',
            message: 'The IBKR sidecar has reconnected to IB Gateway. Normal operation resumed.',
          });
          break;

        case 'orderStatus':
          if (event.status === 'Filled' && forceCheckCallback) {
            forceCheckCallback(event.orderId);
          }
          break;

        case 'error':
          if (event.code === 460) {
            sendSystemAlert({
              severity: 'critical',
              title: 'IBKR margin exceeded',
              message: `Margin violation (error 460): ${event.message}${event.orderId ? ` (order ${event.orderId})` : ''}`,
            });
          }
          break;
      }
    } catch (err) {
      log.debug(`Failed to parse sidecar WebSocket message: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ws.on('close', () => {
    log.info('Sidecar WebSocket closed');
    ws = null;
    if (shouldReconnect) {
      setTimeout(connect, RECONNECT_DELAY_MS);
    }
  });

  ws.on('error', (err) => {
    log.debug(`Sidecar WebSocket error: ${err.message}`);
    // 'close' event will fire after this, triggering reconnect
  });
}

/**
 * Start listening to the sidecar WebSocket for events.
 * Automatically reconnects on close.
 *
 * @param onForceCheck - Optional callback invoked when a Filled orderStatus event
 *   arrives. Typically wired to `orderManager.forceCheck(orderId)`.
 */
export function startWsListener(onForceCheck?: ForceCheckFn): void {
  shouldReconnect = true;
  forceCheckCallback = onForceCheck;
  connect();
}

/** Stop the WebSocket listener and prevent reconnection. */
export function stopWsListener(): void {
  shouldReconnect = false;
  forceCheckCallback = undefined;
  if (ws) {
    ws.close();
    ws = null;
  }
}
