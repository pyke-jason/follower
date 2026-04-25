import type { Trade, TradeFlag, TradeRiskBasis } from '../db/schema.js';
import { roundCents, safeParseFloat } from '../lib/numbers.js';

type TradeQualityGrade = 'A' | 'B' | 'C' | 'D' | 'F';

type TradeQuality = {
  rMultiple: number | null;
  score: number | null;
  grade: TradeQualityGrade | null;
  components: {
    outcome: number | null;
    executionPenalty: number;
    processPenalty: number;
    sizingPenalty: number;
  };
  reasons: string[];
};

type TradeQualityRow = {
  id: string;
  symbol: string;
  trader: string;
  strategy: string;
  closedAt: string | null;
  pnl: number;
  finiteRisk: number | null;
  rMultiple: number | null;
  score: number | null;
  grade: TradeQualityGrade | null;
  reasons: string[];
  flags: TradeFlag[];
};

type TradeQualityGroupAxis = 'strategy' | 'trader' | 'symbol';

type TradeQualityGroupRow = {
  key: string;
  trades: number;
  finiteRiskTrades: number;
  totalPnl: number;
  avgR: number | null;
};

type TradeQualitySummaryOptions = {
  /** Include the per-trade `rows[]` array. Default false to keep the
   *  snapshot payload small for dashboard polling. */
  includeRows?: boolean;
  /** Add a `groupBy` axis result alongside the always-present `byStrategy`. */
  groupBy?: TradeQualityGroupAxis;
};

type TradeQualitySummary = {
  coverage: {
    closedTrades: number;
    withFiniteRisk: number;
    excluded: number;
    coveragePct: number;
    medianFiniteRisk: number | null;
    exclusionReasons: Array<{ reason: TradeRiskBasis; count: number }>;
  };
  rBuckets: Array<{ label: string; count: number }>;
  gradeBuckets: Array<{ grade: TradeQualityGrade; count: number }>;
  flagCounts: Array<{ flag: TradeFlag; count: number }>;
  byStrategy: Array<{
    strategy: string;
    trades: number;
    finiteRiskTrades: number;
    totalPnl: number;
    avgR: number | null;
  }>;
  groupBy?: { axis: TradeQualityGroupAxis; rows: TradeQualityGroupRow[] };
  rows?: TradeQualityRow[];
};

const R_BUCKETS = [
  { label: '<-1R', min: Number.NEGATIVE_INFINITY, max: -1 },
  { label: '-1..0', min: -1, max: 0 },
  { label: '0..+1', min: 0, max: 1 },
  { label: '+1..+2', min: 1, max: 2 },
  { label: '+2..+3', min: 2, max: 3 },
  { label: '>+3R', min: 3, max: Number.POSITIVE_INFINITY },
];

const GRADES: TradeQualityGrade[] = ['A', 'B', 'C', 'D', 'F'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : sorted[mid];
  return value == null ? null : roundCents(value);
}

function gradeForScore(score: number): TradeQualityGrade {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function formatR(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}R`;
}

function flagPenalty(flags: TradeFlag[]): number {
  let penalty = 0;
  if (flags.includes('closeFailed')) penalty += 20;
  if (flags.includes('marketDataFail')) penalty += 15;
  if (flags.includes('chaseDanger')) penalty += 12;
  if (flags.includes('slippage')) penalty += 8;
  if (flags.includes('chaseWarn')) penalty += 6;
  if (flags.includes('autoClose')) penalty += 5;
  return penalty;
}

function buildReasons(params: {
  rMultiple: number;
  flags: TradeFlag[];
  chaseSteps: number;
  slippagePct: number;
  risk: number;
  medianFiniteRisk: number | null;
}): string[] {
  const reasons = [formatR(params.rMultiple)];
  if (params.chaseSteps > 0) reasons.push(`${params.chaseSteps} chase step${params.chaseSteps === 1 ? '' : 's'}`);
  if (params.slippagePct > 0.01) reasons.push('slippage');
  if (params.flags.includes('closeFailed')) reasons.push('close failed');
  if (params.flags.includes('marketDataFail')) reasons.push('market data fail');
  if (params.flags.includes('autoClose')) reasons.push('auto close');
  if (params.medianFiniteRisk != null && params.medianFiniteRisk > 0) {
    const ratio = params.risk / params.medianFiniteRisk;
    if (ratio >= 3) reasons.push('oversized');
    else if (ratio <= 0.5) reasons.push('conservative size');
  }
  return reasons;
}

export function computeTradeQuality(
  trade: Trade,
  medianFiniteRisk: number | null = null,
): TradeQuality {
  const risk = trade.metadata.risk?.peakRisk ?? null;
  const pnl = safeParseFloat(trade.pnl);
  const flags = trade.metadata.flags ?? [];

  if (risk == null || !Number.isFinite(risk) || risk <= 0) {
    return {
      rMultiple: null,
      score: null,
      grade: null,
      components: {
        outcome: null,
        executionPenalty: 0,
        processPenalty: flagPenalty(flags),
        sizingPenalty: 0,
      },
      reasons: ['no finite risk'],
    };
  }

  const rMultiple = roundCents(pnl / risk);
  const outcome = clamp(50 + rMultiple * 20, 0, 100);
  const chaseSteps = trade.metadata.chaseSteps ?? 0;
  const slippagePct = Math.abs(trade.metadata.entrySlippagePct ?? 0)
    + Math.abs(trade.metadata.exitSlippagePct ?? 0);
  const executionPenalty = clamp(chaseSteps * 2 + slippagePct * 150, 0, 25);
  const processPenalty = clamp(flagPenalty(flags), 0, 30);

  let sizingPenalty = 0;
  if (medianFiniteRisk != null && medianFiniteRisk > 0) {
    const ratio = risk / medianFiniteRisk;
    if (ratio >= 3) sizingPenalty = 18;
    else if (ratio >= 2) sizingPenalty = 10;
  }

  const score = Math.round(clamp(outcome - executionPenalty - processPenalty - sizingPenalty, 0, 100));

  return {
    rMultiple,
    score,
    grade: gradeForScore(score),
    components: {
      outcome: roundCents(outcome),
      executionPenalty: roundCents(executionPenalty),
      processPenalty,
      sizingPenalty,
    },
    reasons: buildReasons({ rMultiple, flags, chaseSteps, slippagePct, risk, medianFiniteRisk }),
  };
}

function groupKey(trade: Trade, axis: TradeQualityGroupAxis): string {
  if (axis === 'trader') return trade.trader;
  if (axis === 'symbol') return trade.symbol;
  return trade.strategy;
}

function buildGroupRows(
  trades: Trade[],
  rows: TradeQualityRow[],
  axis: TradeQualityGroupAxis,
): TradeQualityGroupRow[] {
  const map = new Map<string, { trades: number; finiteRiskTrades: number; totalPnl: number; totalR: number }>();
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const row = rows[i];
    const key = groupKey(trade, axis);
    const current = map.get(key) ?? { trades: 0, finiteRiskTrades: 0, totalPnl: 0, totalR: 0 };
    current.trades += 1;
    current.totalPnl = roundCents(current.totalPnl + row.pnl);
    if (row.rMultiple != null) {
      current.finiteRiskTrades += 1;
      current.totalR += row.rMultiple;
    }
    map.set(key, current);
  }
  return [...map.entries()]
    .map(([key, stats]) => ({
      key,
      trades: stats.trades,
      finiteRiskTrades: stats.finiteRiskTrades,
      totalPnl: stats.totalPnl,
      avgR: stats.finiteRiskTrades > 0
        ? roundCents(stats.totalR / stats.finiteRiskTrades)
        : null,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export function computeTradeQualitySummary(
  trades: Trade[],
  options: TradeQualitySummaryOptions = {},
): TradeQualitySummary {
  const finiteRisks = trades
    .map((trade) => trade.metadata.risk?.peakRisk ?? null)
    .filter((risk): risk is number => risk != null && Number.isFinite(risk) && risk > 0);
  const medianFiniteRisk = median(finiteRisks);
  const rows = trades.map<TradeQualityRow>((trade) => {
    const quality = computeTradeQuality(trade, medianFiniteRisk);
    return {
      id: trade.id,
      symbol: trade.symbol,
      trader: trade.trader,
      strategy: trade.strategy,
      closedAt: trade.closedAt,
      pnl: safeParseFloat(trade.pnl),
      finiteRisk: trade.metadata.risk?.peakRisk ?? null,
      rMultiple: quality.rMultiple,
      score: quality.score,
      grade: quality.grade,
      reasons: quality.reasons,
      flags: trade.metadata.flags ?? [],
    };
  });

  const rBuckets = R_BUCKETS.map((bucket) => ({
    label: bucket.label,
    count: rows.filter((row) =>
      row.rMultiple != null
      && row.rMultiple > bucket.min
      && row.rMultiple <= bucket.max,
    ).length,
  }));

  const gradeBuckets = GRADES.map((grade) => ({
    grade,
    count: rows.filter((row) => row.grade === grade).length,
  }));

  const flagMap = new Map<TradeFlag, number>();
  for (const row of rows) {
    for (const flag of row.flags) {
      flagMap.set(flag, (flagMap.get(flag) ?? 0) + 1);
    }
  }

  const strategyGroup = buildGroupRows(trades, rows, 'strategy');
  const byStrategy = strategyGroup.map((g) => ({
    strategy: g.key,
    trades: g.trades,
    finiteRiskTrades: g.finiteRiskTrades,
    totalPnl: g.totalPnl,
    avgR: g.avgR,
  }));

  // Exclusion reasons: bucket trades that lack finite peak risk by their basis.
  const exclusionMap = new Map<TradeRiskBasis, number>();
  for (const trade of trades) {
    const risk = trade.metadata.risk;
    const peak = risk?.peakRisk;
    if (peak != null && Number.isFinite(peak) && peak > 0) continue;
    const reason: TradeRiskBasis = risk?.basis ?? 'unknown';
    exclusionMap.set(reason, (exclusionMap.get(reason) ?? 0) + 1);
  }

  const summary: TradeQualitySummary = {
    coverage: {
      closedTrades: trades.length,
      withFiniteRisk: finiteRisks.length,
      excluded: trades.length - finiteRisks.length,
      coveragePct: trades.length > 0
        ? roundCents(finiteRisks.length / trades.length)
        : 0,
      medianFiniteRisk,
      exclusionReasons: [...exclusionMap.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    },
    rBuckets,
    gradeBuckets,
    flagCounts: [...flagMap.entries()]
      .map(([flag, count]) => ({ flag, count }))
      .sort((a, b) => b.count - a.count),
    byStrategy,
  };

  if (options.groupBy && options.groupBy !== 'strategy') {
    summary.groupBy = {
      axis: options.groupBy,
      rows: buildGroupRows(trades, rows, options.groupBy),
    };
  } else if (options.groupBy === 'strategy') {
    summary.groupBy = { axis: 'strategy', rows: strategyGroup };
  }

  if (options.includeRows) summary.rows = rows;

  return summary;
}
