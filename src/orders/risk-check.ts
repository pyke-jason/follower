import type { Trade } from '../db/schema.js';
import type { PositionFilters } from '../trades/filters.js';
import type { WorkingOrderExposure } from './order-manager.js';
import { safeParseFloat } from '../lib/numbers.js';
import { contractMultiplier, tradeQty, notionalValue, getSpreadWidth } from '../lib/trade.js';
import { parseLegs } from '../db/parse.js';

// ─── Types ──────────────────────────────────────────

export type RiskCheckConfig = {
  maxOnSymbol: number;           // live: 5, backtest: 3
  maxTotalPositions: number;     // both: 20
  maxDrawdownPct: number;        // both: 5
  maxNotionalMultiplier: number; // both: 2 (2x equity leverage cap)
  /** Block new opens when (equity − maintenanceMargin) / equity < this fraction. */
  minMarginCushionPct?: number;  // both: 0.20
};

export type RiskCheckDeps = {
  getOpenTrades: (filters?: PositionFilters) => Promise<Trade[]>;
  getDailyClosedPnl: () => Promise<number>;
  getStartingEquity: () => Promise<number | null>;
  getCurrentEquity: () => Promise<number>;
  getMaintenanceMargin: () => Promise<number | null>;
  getReconciliationAlertCount: () => Promise<number>;
  getWorkingOrderExposure: () => WorkingOrderExposure;
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
  workingOrdersOnSymbol: number;
  workingOrdersTotal: number;
  workingOrderNotional: number;
  marginCushionPct?: number;
};

/**
 * Risk-appropriate notional for an open position.
 * For credit spreads (PCS/CCS): uses max-loss (width − credit) × qty × 100,
 * not the credit received. This prevents the notional cap from being bypassed
 * by small-credit, wide-spread positions.
 */
function positionRiskNotional(trade: Trade): number {
  if (trade.strategy === 'PCS' || trade.strategy === 'CCS') {
    const legs = parseLegs(trade.legs);
    const width = getSpreadWidth(legs);
    const credit = safeParseFloat(trade.entryPrice);
    if (width > 0 && isFinite(credit)) {
      return Math.max(0, width - credit) * tradeQty(trade.quantity) * contractMultiplier(trade.strategy);
    }
  }
  return notionalValue(trade.entryPrice, trade.quantity, trade.strategy);
}

// ─── Implementation ─────────────────────────────────

const DUPLICATE_OPEN_WINDOW_MS = 30_000; // 30-second window for duplicate OPEN detection

export async function checkRiskLimits(
  input: { symbol: string; strategy: string; trader: string; action?: string; direction?: string },
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
      workingOrdersOnSymbol: 0,
      workingOrdersTotal: 0,
      workingOrderNotional: 0,
      marginCushionPct: undefined,
    };
  }

  // 1. Open positions — used for position limits + notional
  const allOpen = await deps.getOpenTrades();
  const onSymbol = allOpen.filter(t => t.symbol === input.symbol);
  const totalOpenPositions = allOpen.length;
  const openPositionsOnSymbol = onSymbol.length;

  // 1a. Duplicate OPEN guard: block if same symbol+direction was opened within 30s
  if (input.action === 'OPEN' && input.direction) {
    const windowStart = new Date(Date.now() - DUPLICATE_OPEN_WINDOW_MS).toISOString();
    const recentDuplicate = onSymbol.find(t =>
      t.direction === input.direction &&
      t.openedAt != null &&
      t.openedAt >= windowStart,
    );
    if (recentDuplicate) {
      return {
        allowed: false,
        reason: `duplicate open suppressed (same position opened < 30s ago, trade ${recentDuplicate.id})`,
        dailyPnl: 0,
        openPositionsOnSymbol,
        totalOpenPositions,
        maxTotalPositions: config.maxTotalPositions,
        totalNotional: 0,
        maxNotional: 0,
        workingOrdersOnSymbol: 0,
        workingOrdersTotal: 0,
        workingOrderNotional: 0,
      };
    }
  }

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

  // 3. Working order exposure (pre-fill risk)
  const workingExposure = deps.getWorkingOrderExposure();
  const effectiveOnSymbol = openPositionsOnSymbol + (workingExposure.countBySymbol.get(input.symbol) ?? 0);
  const effectiveTotal = totalOpenPositions + workingExposure.totalCount;

  // 4. Notional exposure (leverage cap)
  // Use max-loss notional for credit spreads (PCS/CCS) — not the credit received.
  const totalNotional = allOpen.reduce((sum, t) => sum + positionRiskNotional(t), 0);
  const equity = await deps.getCurrentEquity();
  const maxNotional = equity * config.maxNotionalMultiplier;
  const effectiveNotional = totalNotional + workingExposure.totalNotional;
  const notionalBlocked = effectiveNotional > maxNotional;

  // 5. Position limit checks
  const symbolBlocked = effectiveOnSymbol >= config.maxOnSymbol;
  const totalBlocked = effectiveTotal >= config.maxTotalPositions;

  // 6. Margin cushion check — block new opens before approaching margin call
  const maintenanceMargin = await deps.getMaintenanceMargin();
  let marginCushionPct: number | undefined;
  let marginCushionBlocked = false;
  if (config.minMarginCushionPct != null && maintenanceMargin != null && equity > 0) {
    marginCushionPct = Math.round(((equity - maintenanceMargin) / equity) * 10000) / 100;
    if (marginCushionPct / 100 < config.minMarginCushionPct) {
      marginCushionBlocked = true;
    }
  }

  // 7. Reconciliation alerts
  const alertCount = await deps.getReconciliationAlertCount();

  // 8. Result
  const allowed = !symbolBlocked && !totalBlocked && !drawdownBlocked
    && !notionalBlocked && !marginCushionBlocked && alertCount === 0;

  let reason: string | undefined;
  if (marginCushionBlocked) {
    reason = `Margin cushion ${marginCushionPct?.toFixed(1)}% < ${((config.minMarginCushionPct ?? 0) * 100).toFixed(0)}% minimum (equity $${equity.toFixed(0)} maintenance $${maintenanceMargin?.toFixed(0)})`;
  } else if (drawdownBlocked) {
    reason = `Daily drawdown ${currentDrawdownPct}% >= ${config.maxDrawdownPct}%`;
  } else if (notionalBlocked) {
    // Include top 3 positions for debugging
    const positions = allOpen
      .map(t => ({
        sym: t.symbol, strat: t.strategy, dir: t.direction,
        qty: tradeQty(t.quantity), entry: safeParseFloat(t.entryPrice),
        notional: notionalValue(t.entryPrice, t.quantity, t.strategy),
      }))
      .sort((a, b) => b.notional - a.notional)
      .slice(0, 3);
    const posDetail = positions.map(p =>
      `${p.dir} ${p.strat} ${p.sym} qty=${p.qty} @$${p.entry} ($${p.notional.toFixed(0)})`,
    ).join('; ');
    reason = `notional exposure $${effectiveNotional.toFixed(0)} ($${totalNotional.toFixed(0)} open + $${workingExposure.totalNotional.toFixed(0)} working) > ${config.maxNotionalMultiplier}x equity $${maxNotional.toFixed(0)} [top: ${posDetail}]`;
  } else if (symbolBlocked) {
    reason = `${effectiveOnSymbol} positions (${openPositionsOnSymbol} open + ${effectiveOnSymbol - openPositionsOnSymbol} working) on ${input.symbol} (max ${config.maxOnSymbol})`;
  } else if (totalBlocked) {
    reason = `${effectiveTotal} total positions (${totalOpenPositions} open + ${workingExposure.totalCount} working) (max ${config.maxTotalPositions})`;
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
    workingOrdersOnSymbol: workingExposure.countBySymbol.get(input.symbol) ?? 0,
    workingOrdersTotal: workingExposure.totalCount,
    workingOrderNotional: workingExposure.totalNotional,
    marginCushionPct,
  };
}
