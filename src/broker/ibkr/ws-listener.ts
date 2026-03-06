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

const SIDECAR_WS = process.env.IBKR_LIVE_SIDECAR_WS
  ?? process.env.IBKR_PAPER_SIDECAR_WS
  ?? 'ws://localhost:8090/events';
const RECONNECT_DELAY_MS = 5_000;
const PING_INTERVAL_MS = 15_000; // keepalive ping every 15s
const ESCALATION_THRESHOLD_MS = 300_000; // 5 minutes
const ESCALATION_CHECK_MS = 60_000; // 1 minute

type ForceCheckFn = (orderId: number) => void;

let ws: WebSocket | null = null;
let shouldReconnect = true;
let forceCheckCallback: ForceCheckFn | undefined;
let pingTimer: ReturnType<typeof setInterval> | null = null;

// Sustained disconnect tracking
let disconnectedAt: number | null = null;
let hasEscalated = false;
let escalationTimer: ReturnType<typeof setInterval> | null = null;

/** Simple US market hours check: Mon-Fri 9:30-16:00 ET. */
function isDuringMarketHours(): boolean {
  const now = new Date();
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(now);

  const weekday = et.find(p => p.type === 'weekday')?.value ?? '';
  if (['Sat', 'Sun'].includes(weekday)) return false;

  const hour = Number(et.find(p => p.type === 'hour')?.value ?? 0);
  const minute = Number(et.find(p => p.type === 'minute')?.value ?? 0);
  const mins = hour * 60 + minute;
  return mins >= 570 && mins < 960; // 9:30 = 570, 16:00 = 960
}

type ErrorAction =
  | { action: 'alert'; severity: 'critical' | 'warning'; title: string }
  | { action: 'log'; label: string };

/** Single source of truth for how each TWS error code is handled on the TS side. */
const ERROR_ACTIONS: Record<number, ErrorAction> = {
  460:   { action: 'alert', severity: 'critical', title: 'IBKR margin exceeded' },
  10239: { action: 'alert', severity: 'critical', title: 'IBKR account risk exceeded' },
  201:   { action: 'alert', severity: 'warning',  title: 'IBKR order rejected' },
  200:   { action: 'alert', severity: 'warning',  title: 'IBKR order error' },
  203:   { action: 'alert', severity: 'warning',  title: 'IBKR order error' },
  392:   { action: 'alert', severity: 'warning',  title: 'IBKR order error' },
  399:   { action: 'alert', severity: 'warning',  title: 'IBKR order error' },
  404:   { action: 'alert', severity: 'warning',  title: 'IBKR order error' },
  412:   { action: 'alert', severity: 'warning',  title: 'IBKR order error' },
  426:   { action: 'alert', severity: 'warning',  title: 'IBKR order error' },
  202:   { action: 'log', label: 'Order cancelled by IB' },
  110:   { action: 'log', label: 'Tick size violation' },
};

function handleOrderError(code: number, message: string, orderId?: number): void {
  const orderSuffix = orderId ? ` (order ${orderId})` : '';
  const entry = ERROR_ACTIONS[code];
  if (!entry) return;

  if (entry.action === 'alert') {
    sendSystemAlert({
      severity: entry.severity,
      title: entry.title,
      message: `Error ${code}: ${message}${orderSuffix}`,
    });
  } else {
    log.info(`${entry.label} (error ${code}): ${message}${orderSuffix}`);
  }
}

function connect(): void {
  if (ws) return;

  log.info(`Connecting to sidecar WebSocket at ${SIDECAR_WS}`);
  ws = new WebSocket(SIDECAR_WS);

  ws.on('open', () => {
    log.info('Sidecar WebSocket connected');
    // Keepalive ping to prevent idle timeout
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.ping();
    }, PING_INTERVAL_MS);
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
          disconnectedAt = Date.now();
          hasEscalated = false;
          sendSystemAlert({
            severity: 'warning',
            title: 'IBKR sidecar disconnected',
            message: 'The IBKR sidecar lost connection to IB Gateway. Orders will fail until reconnected.',
          });
          break;

        case 'reconnected':
          disconnectedAt = null;
          hasEscalated = false;
          sendSystemAlert({
            severity: 'info',
            title: 'IBKR Gateway reconnected',
            message: 'The IBKR sidecar has reconnected to IB Gateway. Normal operation resumed.',
          });
          break;

        case 'orderStatus':
          // Trigger force-check on terminal statuses so OrderManager picks up changes quickly
          if (forceCheckCallback) {
            if (event.status === 'Filled' || event.status === 'Cancelled' || event.status === 'Inactive') {
              forceCheckCallback(event.orderId);
            }
          }
          break;

        case 'error':
          handleOrderError(event.code, event.message, event.orderId);
          break;

        case 'execDetails':
          if (event.liquidation !== 0) {
            sendSystemAlert({
              severity: 'critical',
              title: 'Forced liquidation detected',
              message: `Order ${event.orderId}: ${event.side} ${event.quantity} ${event.symbol} @ ${event.price}`,
            });
          }
          if (forceCheckCallback) forceCheckCallback(event.orderId);
          break;

        case 'commission':
          log.debug(`Commission: execId=${event.execId} $${event.commission} (order ${event.orderId})`);
          break;
      }
    } catch (err) {
      log.debug(`Failed to parse sidecar WebSocket message: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ws.on('close', () => {
    log.info('Sidecar WebSocket closed');
    ws = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
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

  // Sustained disconnect escalation: check every 60s
  escalationTimer = setInterval(() => {
    if (disconnectedAt && !hasEscalated
        && Date.now() - disconnectedAt > ESCALATION_THRESHOLD_MS
        && isDuringMarketHours()) {
      hasEscalated = true;
      sendSystemAlert({
        severity: 'critical',
        title: 'IBKR sidecar offline >5 min',
        message: `Sidecar has been disconnected for ${Math.round((Date.now() - disconnectedAt) / 60_000)} minutes during market hours.`,
      });
    }
  }, ESCALATION_CHECK_MS);
}

/** Stop the WebSocket listener and prevent reconnection. */
export function stopWsListener(): void {
  shouldReconnect = false;
  forceCheckCallback = undefined;
  disconnectedAt = null;
  hasEscalated = false;
  if (escalationTimer) {
    clearInterval(escalationTimer);
    escalationTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}
