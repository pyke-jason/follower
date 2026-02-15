import type { BacktestConfig, BacktestReport, TraderStats, StrategyStats, EquityPoint, ExtendedMetrics } from './types.js';
import { PositionTracker } from './position-tracker.js';

export function generateReport(
  config: BacktestConfig,
  tracker: PositionTracker,
  totalMessages: number,
  tradableMessages: number,
  stats: {
    agentCallsUsed: number;
    deterministicTrades: number;
    agentTrades: number;
    skippedLowConfidence: number;
  },
  startingEquity: number = 100_000,
): BacktestReport {
  const closed = tracker.getClosed();
  const open = tracker.getOpen();
  const all = tracker.getAll();

  const wins = closed.filter((p) => (p.pnl ?? 0) > 0);
  const losses = closed.filter((p) => (p.pnl ?? 0) < 0);

  const safePnl = (p: { pnl?: number }) => {
    if (p.pnl == null) return 0; // open position — legitimate
    if (!Number.isFinite(p.pnl)) {
      throw new Error(`[Report] Position has non-finite PnL: ${p.pnl}. This indicates data corruption.`);
    }
    return p.pnl;
  };
  const totalPnl = closed.reduce((sum, p) => sum + safePnl(p), 0);
  const avgWin = wins.length > 0
    ? wins.reduce((sum, p) => sum + safePnl(p), 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? losses.reduce((sum, p) => sum + safePnl(p), 0) / losses.length
    : 0;

  const grossWins = wins.reduce((sum, p) => sum + safePnl(p), 0);
  const grossLosses = Math.abs(losses.reduce((sum, p) => sum + safePnl(p), 0));
  // Use 999.99 as a sentinel for Infinity to stay within DB numeric bounds
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999.99 : 0;

  // Max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let running = 0;
  const sortedClosed = [...closed].sort(
    (a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0),
  );
  for (const pos of sortedClosed) {
    running += safePnl(pos);
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // By-trader stats
  const byTrader: Record<string, TraderStats> = {};
  for (const pos of closed) {
    if (!byTrader[pos.trader]) {
      byTrader[pos.trader] = { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 };
    }
    const ts = byTrader[pos.trader];
    ts.trades++;
    if ((pos.pnl ?? 0) > 0) ts.wins++;
    else ts.losses++;
    ts.totalPnl += safePnl(pos);
    ts.winRate = ts.trades > 0 ? ts.wins / ts.trades : 0;
  }

  // By-strategy stats
  const byStrategy: Record<string, StrategyStats> = {};
  for (const pos of closed) {
    if (!byStrategy[pos.strategy]) {
      byStrategy[pos.strategy] = { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0 };
    }
    const ss = byStrategy[pos.strategy];
    ss.trades++;
    if ((pos.pnl ?? 0) > 0) ss.wins++;
    else ss.losses++;
    ss.totalPnl += safePnl(pos);
    ss.winRate = ss.trades > 0 ? ss.wins / ss.trades : 0;
    ss.avgPnl = ss.trades > 0 ? ss.totalPnl / ss.trades : 0;
  }

  // Equity curve (daily)
  const equityCurve: EquityPoint[] = [];
  const dailyMap = new Map<string, { pnl: number; trades: number }>();

  for (const pos of sortedClosed) {
    const date = pos.closedAt?.toISOString().split('T')[0] ?? 'unknown';
    const existing = dailyMap.get(date) ?? { pnl: 0, trades: 0 };
    existing.pnl += safePnl(pos);
    existing.trades++;
    dailyMap.set(date, existing);
  }

  let cumPnl = 0;
  for (const [date, data] of [...dailyMap.entries()].sort()) {
    cumPnl += data.pnl;
    equityCurve.push({
      date,
      pnl: Math.round(data.pnl * 100) / 100,
      cumPnl: Math.round(cumPnl * 100) / 100,
      trades: data.trades,
    });
  }

  // Extended metrics
  const extendedMetrics = computeExtendedMetrics(
    sortedClosed, equityCurve, totalPnl, maxDrawdown, startingEquity,
  );

  return {
    config,
    extendedMetrics,
    summary: {
      totalMessages,
      tradedMessages: tradableMessages,
      totalTrades: all.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? wins.length / closed.length : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      agentCallsUsed: stats.agentCallsUsed,
      deterministicTrades: stats.deterministicTrades,
      agentTrades: stats.agentTrades,
      skippedLowConfidence: stats.skippedLowConfidence,
      openAtEnd: open.length,
    },
    byTrader,
    byStrategy,
    equityCurve,
  };
}

function computeExtendedMetrics(
  sortedClosed: { pnl?: number; openedAt: Date; closedAt?: Date }[],
  equityCurve: EquityPoint[],
  totalPnl: number,
  maxDrawdown: number,
  startingEquity: number,
): ExtendedMetrics {
  const r2 = (v: number) => Math.round(v * 100) / 100;

  // Daily PnL array from equity curve
  const dailyPnls = equityCurve.map((pt) => pt.pnl);
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
    ? r2((meanDailyPnl / dailyStdDev) * Math.sqrt(252))
    : 0;

  // Sortino: same but downside deviation only
  const negativePnls = dailyPnls.filter((v) => v < 0);
  const downsideVariance = negativePnls.length > 1
    ? negativePnls.reduce((s, v) => s + v ** 2, 0) / negativePnls.length
    : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideDev > 0
    ? r2((meanDailyPnl / downsideDev) * Math.sqrt(252))
    : 0;

  // Calmar: annualized return / max drawdown %
  const annualizedReturn = (totalPnl / startingEquity) * (252 / tradingDays);
  const maxDrawdownPct = maxDrawdown / startingEquity;
  const calmarRatio = maxDrawdownPct > 0
    ? r2(annualizedReturn / maxDrawdownPct)
    : 0;

  // Recovery factor: totalPnl / maxDrawdown
  const recoveryFactor = maxDrawdown > 0 ? r2(totalPnl / maxDrawdown) : 0;

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
    ? r2(holdingHours.reduce((s, v) => s + v, 0) / holdingHours.length)
    : 0;

  // Per-trade PnL array
  const tradePnls = sortedClosed.map((p) => p.pnl ?? 0);

  // Median PnL
  const sortedPnls = [...tradePnls].sort((a, b) => a - b);
  const medianPnl = sortedPnls.length > 0
    ? r2(sortedPnls.length % 2 === 1
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
  const pnlStdDev = r2(Math.sqrt(pnlVariance));

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

export function printReport(report: BacktestReport): void {
  const s = report.summary;

  console.log('\n' + '='.repeat(60));
  console.log('  BACKTEST REPORT');
  console.log('='.repeat(60));
  console.log(`  Period:     ${report.config.startDate.toISOString().split('T')[0]} to ${report.config.endDate.toISOString().split('T')[0]}`);
  console.log(`  Traders:    ${report.config.traders.join(', ')}`);
  console.log(`  Agent mode: ${report.config.useAgent ? 'hybrid' : 'deterministic only'}`);
  console.log('');

  console.log('  SUMMARY');
  console.log('  ' + '-'.repeat(40));
  console.log(`  Total messages:      ${s.totalMessages}`);
  console.log(`  Tradable messages:   ${s.tradedMessages}`);
  console.log(`  Total trades:        ${s.totalTrades}`);
  console.log(`  Wins / Losses:       ${s.wins} / ${s.losses}`);
  console.log(`  Win rate:            ${(s.winRate * 100).toFixed(1)}%`);
  console.log(`  Total P&L:           $${s.totalPnl.toFixed(2)}`);
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
  console.log(`  Deterministic:       ${s.deterministicTrades}`);
  console.log(`  Agent:               ${s.agentTrades}`);
  console.log(`  Agent calls used:    ${s.agentCallsUsed}`);
  console.log(`  Skipped (low conf):  ${s.skippedLowConfidence}`);
  console.log('');

  if (Object.keys(report.byTrader).length > 0) {
    console.log('  BY TRADER');
    console.log('  ' + '-'.repeat(40));
    for (const [name, ts] of Object.entries(report.byTrader)) {
      console.log(`  ${name.padEnd(15)} ${ts.trades} trades | ${(ts.winRate * 100).toFixed(1)}% WR | $${ts.totalPnl.toFixed(2)}`);
    }
    console.log('');
  }

  if (Object.keys(report.byStrategy).length > 0) {
    console.log('  BY STRATEGY');
    console.log('  ' + '-'.repeat(40));
    for (const [name, ss] of Object.entries(report.byStrategy)) {
      console.log(`  ${name.padEnd(8)} ${ss.trades} trades | ${(ss.winRate * 100).toFixed(1)}% WR | $${ss.totalPnl.toFixed(2)} | avg $${ss.avgPnl.toFixed(2)}`);
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
