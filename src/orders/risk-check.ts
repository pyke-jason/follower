import type { Trade } from '../db/schema.js';
import { safeParseFloat } from '../lib/numbers.js';
import { contractMultiplier, tradeQty } from '../lib/trade.js';

// ─── Types ──────────────────────────────────────────

export type RiskCheckConfig = {
  maxOnSymbol: number;           // live: 5, backtest: 3
  maxTotalPositions: number;     // both: 20
  maxDrawdownPct: number;        // both: 5
  maxNotionalMultiplier: number; // both: 2 (2x equity leverage cap)
};

export type RiskCheckDeps = {
  getOpenTrades: (filters?: { symbol?: string; trader?: string }) => Promise<Trade[]>;
  getDailyClosedPnl: () => Promise<number>;
  getStartingEquity: () => Promise<number | null>;
  getCurrentEquity: () => Promise<number>;
  getReconciliationAlertCount?: () => Promise<number>; // live only
};

export type RiskCheckResult = {
  allowed: boolean;
  reason?: string;
  dailyPnl: number;
  openPositionsOnSymbol: number;
  totalOpenPositions: number;
  maxTotalPositions: number;
  startingEquity?: number;
  currentDrawdownPct?: number;
  reconciliationAlerts?: number;
  totalNotional: number;
  maxNotional: number;
};

// ─── Implementation ─────────────────────────────────

export async function checkRiskLimits(
  input: { symbol: string; strategy: string; trader: string; action?: string },
  deps: RiskCheckDeps,
  config: RiskCheckConfig,
): Promise<RiskCheckResult> {
  // Position-reducing trades always pass — closing/trimming should never be blocked
  // by the very exposure they're trying to reduce.
  if (input.action === 'CLOSE' || input.action === 'TRIM') {
    return {
      allowed: true,
      dailyPnl: 0,
      openPositionsOnSymbol: 0,
      totalOpenPositions: 0,
      maxTotalPositions: config.maxTotalPositions,
      totalNotional: 0,
      maxNotional: 0,
    };
  }

  // 1. Open positions — used for position limits + notional
  const allOpen = await deps.getOpenTrades();
  const onSymbol = allOpen.filter(t => t.symbol === input.symbol);
  const totalOpenPositions = allOpen.length;
  const openPositionsOnSymbol = onSymbol.length;

  // 2. Daily closed PnL + drawdown
  const dailyPnl = await deps.getDailyClosedPnl();
  const startingEquity = await deps.getStartingEquity();
  let currentDrawdownPct: number | undefined;
  let drawdownBlocked = false;

  if (startingEquity != null && startingEquity > 0 && dailyPnl < 0) {
    currentDrawdownPct = Math.round((Math.abs(dailyPnl) / startingEquity) * 10000) / 100;
    if (currentDrawdownPct >= config.maxDrawdownPct) {
      drawdownBlocked = true;
    }
  }

  // 3. Notional exposure (leverage cap)
  const totalNotional = allOpen.reduce((sum, t) => {
    return sum + Math.abs(safeParseFloat(t.entryPrice) * tradeQty(t.quantity) * contractMultiplier(t.strategy));
  }, 0);
  const equity = await deps.getCurrentEquity();
  const maxNotional = equity * config.maxNotionalMultiplier;
  const notionalBlocked = totalNotional > maxNotional;

  // 4. Position limit checks
  const symbolBlocked = openPositionsOnSymbol >= config.maxOnSymbol;
  const totalBlocked = totalOpenPositions >= config.maxTotalPositions;

  // 5. Reconciliation alerts (live only)
  const alertCount = deps.getReconciliationAlertCount
    ? await deps.getReconciliationAlertCount()
    : 0;

  // 6. Result
  const allowed = !symbolBlocked && !totalBlocked && !drawdownBlocked
    && !notionalBlocked && alertCount === 0;

  let reason: string | undefined;
  if (drawdownBlocked) {
    reason = `Daily drawdown ${currentDrawdownPct}% >= ${config.maxDrawdownPct}%`;
  } else if (notionalBlocked) {
    // Include top 3 positions for debugging
    const positions = allOpen
      .map(t => ({
        sym: t.symbol, strat: t.strategy, dir: t.direction,
        qty: tradeQty(t.quantity), entry: safeParseFloat(t.entryPrice),
        notional: Math.abs(safeParseFloat(t.entryPrice) * tradeQty(t.quantity) * contractMultiplier(t.strategy)),
      }))
      .sort((a, b) => b.notional - a.notional)
      .slice(0, 3);
    const posDetail = positions.map(p =>
      `${p.dir} ${p.strat} ${p.sym} qty=${p.qty} @$${p.entry} ($${p.notional.toFixed(0)})`,
    ).join('; ');
    reason = `notional exposure $${totalNotional.toFixed(0)} > ${config.maxNotionalMultiplier}x equity $${maxNotional.toFixed(0)} [top: ${posDetail}]`;
  } else if (symbolBlocked) {
    reason = `${openPositionsOnSymbol} positions on ${input.symbol} (max ${config.maxOnSymbol})`;
  } else if (totalBlocked) {
    reason = `${totalOpenPositions} total positions (max ${config.maxTotalPositions})`;
  } else if (alertCount > 0) {
    reason = `${alertCount} unresolved DB_ONLY reconciliation alert(s)`;
  }

  return {
    allowed,
    reason,
    dailyPnl,
    openPositionsOnSymbol,
    totalOpenPositions,
    maxTotalPositions: config.maxTotalPositions,
    startingEquity: startingEquity ?? undefined,
    currentDrawdownPct,
    reconciliationAlerts: alertCount > 0 ? alertCount : undefined,
    totalNotional,
    maxNotional,
  };
}
