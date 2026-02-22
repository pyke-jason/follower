import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { sendSystemAlert } from '../lib/alert.js';
import { isOpen, notBacktest } from '../trades/filters.js';
import { createLogger } from '../lib/logger.js';
import { isTradingDay, toDateKeyET, getETMinuteOfDay as etMinute } from '../lib/et-date.js';

const log = createLogger('EOD');

// ─── EOD Position Sweep ──────────────────────────────
// Alerts on open positions approaching market close.
// Does NOT auto-close — too dangerous without explicit user intent.
// Creates MANUAL_REVIEW tasks for positions that need attention.

const DEFAULT_SWEEP_MINUTE = 950; // 15:50 ET (10 min before close)

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let lastSweepDate: string | null = null; // YYYY-MM-DD, prevents double-firing

function isMarketOpen(): boolean {
  return isTradingDay(new Date());
}

function getETMinuteOfDay(): number {
  return etMinute(new Date());
}

function getTodayDateString(): string {
  return toDateKeyET(new Date());
}

async function sweepOpenPositions(): Promise<void> {
  const today = getTodayDateString();
  if (lastSweepDate === today) return; // already swept today

  const openTrades = await db.select()
    .from(schema.trades)
    .where(and(isOpen, notBacktest));

  if (openTrades.length === 0) return;

  // Filter to positions opened today (day trades at risk of overnight hold)
  const todayTrades = openTrades.filter((t) => t.openedAt?.startsWith(today));
  // Also include all open positions — any open position at EOD deserves a heads-up
  const allOpen = openTrades;

  lastSweepDate = today;

  // Create MANUAL_REVIEW tasks for today's trades that are still open
  for (const trade of todayTrades) {
    // Deduplicate: skip if a PENDING MANUAL_REVIEW task already exists for this trade
    const existingTask = await db.select().from(schema.tasks)
      .where(and(
        eq(schema.tasks.taskType, 'MANUAL_REVIEW'),
        eq(schema.tasks.status, 'PENDING'),
        sql`json_extract(context, '$.tradeId') = ${trade.id}`,
      ))
      .limit(1);

    if (existingTask.length > 0) continue;

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

  log.info(`Sweep complete: ${todayTrades.length} today, ${allOpen.length} total open`);
}

export function startEodSweep(sweepMinuteET: number = DEFAULT_SWEEP_MINUTE): void {
  // Check every minute if it's time to sweep
  sweepTimer = setInterval(() => {
    if (!isMarketOpen()) return;
    const minute = getETMinuteOfDay();
    // Fire within a 5-minute window starting at the configured time
    if (minute >= sweepMinuteET && minute < sweepMinuteET + 5) {
      sweepOpenPositions().catch((err) => {
        log.error('Sweep failed:', err);
        sendSystemAlert({
          title: 'EOD sweep failed',
          message: `Scheduled EOD sweep threw: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'warning',
        });
      });
    }
  }, 60_000);

  log.info(`Sweep scheduled at ET minute ${sweepMinuteET} (${Math.floor(sweepMinuteET / 60)}:${String(sweepMinuteET % 60).padStart(2, '0')})`);
}

export function stopEodSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// Exposed for testing
export { sweepOpenPositions as _sweepOpenPositions };
