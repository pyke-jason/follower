import type { BacktestConfig, BacktestReport, TraderStats, StrategyStats, EquityPoint, ExtendedMetrics } from './types.js';
import type { CommissionSchedule } from '../db/schema.js';
import { safeParseFloat, roundCents, PROFIT_FACTOR_INF, pctDisplay } from '../lib/numbers.js';
import { computeTradeCommission, computeEntrySideCommission } from '../lib/commission.js';

export type MtmSnapshot = {
  date: string;
  unrealizedPnl: number;
};

function computeExtendedMetrics(params: {
  sortedClosed: { pnl?: number; openedAt: Date; closedAt?: Date }[];
  equityCurve: EquityPoint[];
  totalPnl: number;
  maxDrawdown: number;
  startingEquity: number;
}): ExtendedMetrics {
  const { sortedClosed, equityCurve, totalPnl, maxDrawdown, startingEquity } = params;

  // Daily PnL from equity deltas (captures unrealized swings) when MTM data exists,
  // otherwise falls back to realized daily pnl.
  const hasMtm = equityCurve.some((pt) => pt.equity != null);
  const dailyPnls = hasMtm
    ? (() => {
        const equities = equityCurve.map((pt) => pt.equity ?? pt.cumPnl);
        return equities.slice(1).map((eq, i) => eq - equities[i]);
      })()
    : equityCurve.map((pt) => pt.pnl);
  const tradingDays = dailyPnls.length || 1;

  const meanDailyPnl = dailyPnls.length > 0
    ? dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length
    : 0;

  // Std dev of daily PnL
  const dailyVariance = dailyPnls.length > 1
    ? dailyPnls.reduce((s, v) => s + (v - meanDailyPnl) ** 2, 0) / (dailyPnls.length - 1)
    : 0;
  const dailyStdDev = Math.sqrt(dailyVariance);

  // Sharpe: (mean daily return / std dev) * sqrt(252)
  const sharpeRatio = dailyStdDev > 0
    ? roundCents((meanDailyPnl / dailyStdDev) * Math.sqrt(252))
    : 0;

  // Sortino: same but downside deviation only (sum negative squared over ALL observations)
  const hasNegative = dailyPnls.some((v) => v < 0);
  const downsideVariance = hasNegative && dailyPnls.length > 1
    ? dailyPnls.reduce((s, v) => s + (v < 0 ? v ** 2 : 0), 0) / dailyPnls.length
    : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideDev > 0
    ? roundCents((meanDailyPnl / downsideDev) * Math.sqrt(252))
    : 0;

  // Calmar: annualized return / max drawdown %
  const annualizedReturn = (totalPnl / startingEquity) * (252 / tradingDays);
  const maxDrawdownPct = maxDrawdown / startingEquity;
  const calmarRatio = maxDrawdownPct > 0
    ? roundCents(annualizedReturn / maxDrawdownPct)
    : 0;

  // Recovery factor: totalPnl / maxDrawdown
  const recoveryFactor = maxDrawdown > 0 ? roundCents(totalPnl / maxDrawdown) : 0;

  // Consecutive win/loss streaks
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currentWins = 0;
  let currentLosses = 0;
  for (const pos of sortedClosed) {
    if ((pos.pnl ?? 0) > 0) {
      currentWins++;
      currentLosses = 0;
      if (currentWins > maxConsecutiveWins) maxConsecutiveWins = currentWins;
    } else {
      currentLosses++;
      currentWins = 0;
      if (currentLosses > maxConsecutiveLosses) maxConsecutiveLosses = currentLosses;
    }
  }

  // Avg holding period in hours
  const holdingHours = sortedClosed
    .filter((p) => p.closedAt && p.openedAt)
    .map((p) => (p.closedAt!.getTime() - p.openedAt.getTime()) / (1000 * 60 * 60));
  const avgHoldingPeriodHours = holdingHours.length > 0
    ? roundCents(holdingHours.reduce((s, v) => s + v, 0) / holdingHours.length)
    : 0;

  // Per-trade PnL array
  const tradePnls = sortedClosed.map((p) => p.pnl ?? 0);

  // Median PnL
  const sortedPnls = [...tradePnls].sort((a, b) => a - b);
  const medianPnl = sortedPnls.length > 0
    ? roundCents(sortedPnls.length % 2 === 1
      ? sortedPnls[Math.floor(sortedPnls.length / 2)]
      : (sortedPnls[sortedPnls.length / 2 - 1] + sortedPnls[sortedPnls.length / 2]) / 2)
    : 0;

  // PnL std dev
  const meanPnl = tradePnls.length > 0
    ? tradePnls.reduce((s, v) => s + v, 0) / tradePnls.length
    : 0;
  const pnlVariance = tradePnls.length > 1
    ? tradePnls.reduce((s, v) => s + (v - meanPnl) ** 2, 0) / (tradePnls.length - 1)
    : 0;
  const pnlStdDev = roundCents(Math.sqrt(pnlVariance));

  return {
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    recoveryFactor,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    avgHoldingPeriodHours,
    medianPnl,
    pnlStdDev,
  };
}

/**
 * Trade-derived stats: summary, breakdowns, equity curve.
 * Shared by the runner (generateReportFromTrades) and the web detail page.
 *
 * When commissionSchedule is provided, all P&L metrics (wins/losses, drawdown,
 * equity curve, profit factor) use net P&L (gross minus commission). The gross
 * totalPnl is preserved in the summary for reference.
 */
export function computeCoreStats<T extends {
  pnl: string | null; status: string; trader: string; strategy: string;
  quantity: number | null; legs: unknown[] | null;
  openedAt: string | null; closedAt: string | null;
}>(trades: T[], mtmSnapshots?: MtmSnapshot[], startingEquity = 100_000, commissionSchedule?: CommissionSchedule) {
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const open = trades.filter((t) => t.status !== 'CLOSED');

  // Per-trade net PnL (gross minus round-trip commission)
  const netPnlOf = (t: T) => safeParseFloat(t.pnl) - computeTradeCommission(t, commissionSchedule);

  const wins = closed.filter((t) => netPnlOf(t) > 0);
  const losses = closed.filter((t) => netPnlOf(t) <= 0);

  const totalGrossPnl = closed.reduce((sum, t) => sum + safeParseFloat(t.pnl), 0);
  const closedCommissions = closed.reduce((sum, t) => sum + computeTradeCommission(t, commissionSchedule), 0);
  const openCommissions = open.reduce((sum, t) => sum + computeEntrySideCommission(t, commissionSchedule), 0);
  const totalCommissions = roundCents(closedCommissions + openCommissions);
  const totalNetPnl = roundCents(totalGrossPnl - closedCommissions);

  const grossWins = wins.reduce((sum, t) => sum + netPnlOf(t), 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + netPnlOf(t), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? PROFIT_FACTOR_INF : 0;

  // Max drawdown from closed trades in chronological order (using net PnL)
  const sortedClosed = [...closed].sort(
    (a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''),
  );
  let peak = 0, maxDrawdown = 0, running = 0;
  for (const t of sortedClosed) {
    running += netPnlOf(t);
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // By-trader stats (net)
  const byTrader: Record<string, TraderStats> = {};
  for (const t of closed) {
    const net = netPnlOf(t);
    const ts = byTrader[t.trader] ??= { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 };
    ts.trades++;
    if (net > 0) ts.wins++; else ts.losses++;
    ts.totalPnl += net;
    ts.winRate = ts.wins / ts.trades;
  }

  // By-strategy stats (net)
  const byStrategy: Record<string, StrategyStats> = {};
  for (const t of closed) {
    const net = netPnlOf(t);
    const ss = byStrategy[t.strategy] ??= { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0 };
    ss.trades++;
    if (net > 0) ss.wins++; else ss.losses++;
    ss.totalPnl += net;
    ss.winRate = ss.wins / ss.trades;
    ss.avgPnl = ss.totalPnl / ss.trades;
  }

  // Equity curve (daily, using net PnL)
  const dailyMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of sortedClosed) {
    const date = t.closedAt?.split('T')[0] ?? 'unknown';
    const existing = dailyMap.get(date) ?? { pnl: 0, trades: 0 };
    existing.pnl += netPnlOf(t);
    existing.trades++;
    dailyMap.set(date, existing);
  }
  const mtmByDate = new Map<string, number>();
  if (mtmSnapshots) {
    for (const snap of mtmSnapshots) mtmByDate.set(snap.date, snap.unrealizedPnl);
  }
  const equityCurve: EquityPoint[] = [];
  let cumPnl = 0;
  for (const [date, data] of [...dailyMap.entries()].sort()) {
    cumPnl += data.pnl;
    const unrealizedPnl = mtmByDate.get(date) ?? 0;
    const hasUnrealized = mtmByDate.has(date);
    equityCurve.push({
      date,
      pnl: roundCents(data.pnl),
      cumPnl: roundCents(cumPnl),
      trades: data.trades,
      unrealizedPnl: hasUnrealized ? roundCents(unrealizedPnl) : undefined,
      equity: hasUnrealized ? roundCents(cumPnl + unrealizedPnl) : undefined,
    });
  }

  const summary = {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    totalPnl: roundCents(totalGrossPnl),
    netPnl: totalNetPnl,
    totalCommissions,
    avgWin: roundCents(wins.length > 0 ? grossWins / wins.length : 0),
    avgLoss: roundCents(losses.length > 0 ? (grossLosses / losses.length) * -1 : 0),
    maxDrawdown: roundCents(maxDrawdown),
    profitFactor: roundCents(profitFactor),
    openAtEnd: open.length,
  };

  return { summary, byTrader, byStrategy, equityCurve, sortedClosed };
}

/**
 * Compute report stats from raw DB trade rows.
 * Thin wrapper: calls computeCoreStats then adds decision-derived execution stats + extendedMetrics.
 */
export function generateReportFromTrades(params: {
  trades: { pnl: string | null; status: string; trader: string; strategy: string;
            quantity: number | null; legs: unknown[] | null;
            entryPrice: string | null; openedAt: string | null; closedAt: string | null }[];
  decisions: { path: string; decision: string }[];
  mtmSnapshots?: MtmSnapshot[];
  startingEquity?: number;
  commissionSchedule?: CommissionSchedule;
}): Pick<BacktestReport, 'summary' | 'byTrader' | 'byStrategy' | 'equityCurve' | 'extendedMetrics'> {
  const { trades, decisions, mtmSnapshots, startingEquity = 100_000, commissionSchedule } = params;
  const { summary: core, byTrader, byStrategy, equityCurve, sortedClosed } = computeCoreStats(trades, mtmSnapshots, startingEquity, commissionSchedule);

  // Derive execution stats from decisions — count both live agent and cached intent paths
  const isClassified = (d: { path: string }) => d.path === 'agent' || d.path === 'intent';
  const agentTrades = decisions.filter((d) => isClassified(d) && d.decision === 'EXECUTE').length;
  const agentCallsUsed = decisions.filter((d) => isClassified(d)).length;
  const skipped = decisions.filter((d) => d.decision === 'SKIP').length;

  // Extended metrics (use net PnL from core summary)
  const netPnlOf = (t: typeof sortedClosed[number]) =>
    safeParseFloat(t.pnl) - computeTradeCommission(t, commissionSchedule);
  const sortedForMetrics = sortedClosed
    .filter((t) => t.openedAt != null)
    .map((t) => ({
      pnl: netPnlOf(t),
      openedAt: new Date(t.openedAt!),
      closedAt: t.closedAt ? new Date(t.closedAt) : undefined,
    }));
  const extendedMetrics = computeExtendedMetrics({
    sortedClosed: sortedForMetrics, equityCurve, totalPnl: core.netPnl ?? core.totalPnl,
    maxDrawdown: core.maxDrawdown, startingEquity,
  });

  return {
    summary: {
      ...core,
      totalMessages: 0,
      tradedMessages: 0,
      agentCallsUsed,
      agentTrades,
      skipped,
    },
    byTrader,
    byStrategy,
    equityCurve,
    extendedMetrics,
  };
}

export function printReport(report: BacktestReport): void {
  const s = report.summary;

  console.log('\n' + '='.repeat(60));
  console.log('  BACKTEST REPORT');
  console.log('='.repeat(60));
  console.log(`  Period:     ${report.config.startDate.split('T')[0]} to ${report.config.endDate.split('T')[0]}`);
  console.log(`  Traders:    ${report.config.traders.join(', ')}`);
  console.log(`  Agent:      ${report.config.agentProvider ?? 'anthropic'}/${report.config.agentModel ?? 'default'}`);
  console.log('');

  console.log('  SUMMARY');
  console.log('  ' + '-'.repeat(40));
  console.log(`  Total messages:      ${s.totalMessages}`);
  console.log(`  Tradable messages:   ${s.tradedMessages}`);
  console.log(`  Total trades:        ${s.totalTrades}`);
  console.log(`  Wins / Losses:       ${s.wins} / ${s.losses}`);
  console.log(`  Win rate:            ${pctDisplay(s.winRate)}`);
  if (s.totalCommissions && s.totalCommissions > 0) {
    console.log(`  Gross P&L:           $${s.totalPnl.toFixed(2)}`);
    console.log(`  Commissions:         -$${s.totalCommissions.toFixed(2)}`);
    console.log(`  Net P&L:             $${(s.netPnl ?? s.totalPnl).toFixed(2)}`);
  } else {
    console.log(`  Total P&L:           $${s.totalPnl.toFixed(2)}`);
  }
  console.log(`  Avg win:             $${s.avgWin.toFixed(2)}`);
  console.log(`  Avg loss:            $${s.avgLoss.toFixed(2)}`);
  console.log(`  Max drawdown:        $${s.maxDrawdown.toFixed(2)}`);
  console.log(`  Profit factor:       ${s.profitFactor.toFixed(2)}`);
  console.log(`  Open at end:         ${s.openAtEnd}`);
  console.log('');

  const em = report.extendedMetrics;
  console.log('  RISK METRICS');
  console.log('  ' + '-'.repeat(40));
  console.log(`  Sharpe ratio:        ${em.sharpeRatio.toFixed(2)}`);
  console.log(`  Sortino ratio:       ${em.sortinoRatio.toFixed(2)}`);
  console.log(`  Calmar ratio:        ${em.calmarRatio.toFixed(2)}`);
  console.log(`  Recovery factor:     ${em.recoveryFactor.toFixed(2)}`);
  console.log(`  Max consec. wins:    ${em.maxConsecutiveWins}`);
  console.log(`  Max consec. losses:  ${em.maxConsecutiveLosses}`);
  console.log(`  Avg holding (hrs):   ${em.avgHoldingPeriodHours.toFixed(1)}`);
  console.log(`  Median P&L:          $${em.medianPnl.toFixed(2)}`);
  console.log(`  P&L std dev:         $${em.pnlStdDev.toFixed(2)}`);
  console.log('');

  console.log('  EXECUTION');
  console.log('  ' + '-'.repeat(40));
  console.log(`  Agent trades:        ${s.agentTrades}`);
  console.log(`  Agent calls:         ${s.agentCallsUsed}`);
  console.log(`  Skipped:             ${s.skipped}`);
  console.log('');

  if (report.skipReasons && Object.keys(report.skipReasons).length > 0) {
    const totalSkipped = Object.values(report.skipReasons).reduce((a, b) => a + b, 0);
    console.log(`  SKIP REASONS (${totalSkipped} skipped)`);
    console.log('  ' + '-'.repeat(40));
    const sorted = Object.entries(report.skipReasons).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sorted) {
      const pct = ((count / totalSkipped) * 100).toFixed(0);
      console.log(`  ${reason.padEnd(32)} ${String(count).padStart(4)}  (${pct.padStart(2)}%)`);
    }
    console.log('');
  }

  if (Object.keys(report.byTrader).length > 0) {
    console.log('  BY TRADER');
    console.log('  ' + '-'.repeat(40));
    for (const [name, ts] of Object.entries(report.byTrader)) {
      console.log(`  ${name.padEnd(15)} ${ts.trades} trades | ${pctDisplay(ts.winRate)} WR | $${ts.totalPnl.toFixed(2)}`);
    }
    console.log('');
  }

  if (Object.keys(report.byStrategy).length > 0) {
    console.log('  BY STRATEGY');
    console.log('  ' + '-'.repeat(40));
    for (const [name, ss] of Object.entries(report.byStrategy)) {
      console.log(`  ${name.padEnd(8)} ${ss.trades} trades | ${pctDisplay(ss.winRate)} WR | $${ss.totalPnl.toFixed(2)} | avg $${ss.avgPnl.toFixed(2)}`);
    }
    console.log('');
  }

  if (report.equityCurve.length > 0) {
    console.log('  EQUITY CURVE (last 10 days)');
    console.log('  ' + '-'.repeat(40));
    const lastDays = report.equityCurve.slice(-10);
    for (const pt of lastDays) {
      const bar = pt.pnl >= 0 ? '+' : '-';
      console.log(`  ${pt.date}  ${bar}$${Math.abs(pt.pnl).toFixed(2).padStart(8)}  cum: $${pt.cumPnl.toFixed(2).padStart(10)}  (${pt.trades} trades)`);
    }
  }

  console.log('\n' + '='.repeat(60));
}
