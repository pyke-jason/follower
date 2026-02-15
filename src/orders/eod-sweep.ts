import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { sendSystemAlert } from '../lib/alert.js';

// ─── EOD Position Sweep ──────────────────────────────
// Alerts on open positions approaching market close.
// Does NOT auto-close — too dangerous without explicit user intent.
// Creates MANUAL_REVIEW tasks for positions that need attention.

const DEFAULT_SWEEP_MINUTE = 950; // 15:50 ET (10 min before close)

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let lastSweepDate: string | null = null; // YYYY-MM-DD, prevents double-firing

function getETNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function isWeekday(): boolean {
  const day = getETNow().getDay();
  return day !== 0 && day !== 6;
}

const MARKET_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
  '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25',
]);

function isMarketOpen(): boolean {
  if (!isWeekday()) return false;
  return !MARKET_HOLIDAYS.has(getTodayDateString());
}

function getETMinuteOfDay(): number {
  const et = getETNow();
  return et.getHours() * 60 + et.getMinutes();
}

function getTodayDateString(): string {
  const et = getETNow();
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

async function sweepOpenPositions(): Promise<void> {
  const today = getTodayDateString();
  if (lastSweepDate === today) return; // already swept today

  const openTrades = await db.select()
    .from(schema.trades)
    .where(and(
      eq(schema.trades.status, 'OPEN'),
      eq(schema.trades.isBacktest, false),
    ));

  if (openTrades.length === 0) return;

  // Filter to positions opened today (day trades at risk of overnight hold)
  const todayTrades = openTrades.filter((t) => t.openedAt?.startsWith(today));
  // Also include all open positions — any open position at EOD deserves a heads-up
  const allOpen = openTrades;

  lastSweepDate = today;

  // Create MANUAL_REVIEW tasks for today's trades that are still open
  for (const trade of todayTrades) {
    await db.insert(schema.tasks).values({
      messageId: trade.sourceMessageId,
      taskType: 'MANUAL_REVIEW',
      status: 'PENDING',
      assignee: 'human',
      priority: 10, // high priority
      context: {
        eodSweep: true,
        tradeId: trade.id,
        symbol: trade.symbol,
        trader: trade.trader,
        strategy: trade.strategy,
        direction: trade.direction,
        openedAt: trade.openedAt,
      },
    });
  }

  const todaySymbols = todayTrades.map((t) => `${t.symbol} (${t.strategy})`).join(', ');
  const allSymbols = allOpen.map((t) => `${t.symbol} (${t.strategy})`).join(', ');

  sendSystemAlert({
    title: 'EOD position sweep',
    message: todayTrades.length > 0
      ? `${todayTrades.length} position(s) opened today still open near close: ${todaySymbols}. ${allOpen.length} total open.`
      : `${allOpen.length} open position(s) approaching market close: ${allSymbols}`,
    severity: todayTrades.length > 0 ? 'critical' : 'warning',
    fields: [
      { name: 'Opened Today', value: String(todayTrades.length), inline: true },
      { name: 'Total Open', value: String(allOpen.length), inline: true },
    ],
  });

  console.log(`[EOD] Sweep complete: ${todayTrades.length} today, ${allOpen.length} total open`);
}

export function startEodSweep(sweepMinuteET: number = DEFAULT_SWEEP_MINUTE): void {
  // Check every minute if it's time to sweep
  sweepTimer = setInterval(() => {
    if (!isMarketOpen()) return;
    const minute = getETMinuteOfDay();
    // Fire within a 5-minute window starting at the configured time
    if (minute >= sweepMinuteET && minute < sweepMinuteET + 5) {
      sweepOpenPositions().catch((err) => {
        console.error('[EOD] Sweep failed:', err);
        sendSystemAlert({
          title: 'EOD sweep failed',
          message: `Scheduled EOD sweep threw: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'warning',
        });
      });
    }
  }, 60_000);

  console.log(`[EOD] Sweep scheduled at ET minute ${sweepMinuteET} (${Math.floor(sweepMinuteET / 60)}:${String(sweepMinuteET % 60).padStart(2, '0')})`);
}

export function stopEodSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// Exposed for testing
export { sweepOpenPositions as _sweepOpenPositions };
