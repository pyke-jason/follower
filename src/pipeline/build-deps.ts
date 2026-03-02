/**
 * Pipeline dependency factory.
 *
 * Single construction site for all pipeline deps. Runners provide 3 primitives:
 *   broker  — BrokerService implementation (live or sim)
 *   env     — Environment (clock, scope, optional alerts)
 *   config  — PipelineConfig (risk, agent identity, sizing)
 *
 * Everything else — OrderManager, riskDeps, position sizing, trade recording,
 * pending intent tracking, position queries — is derived internally.
 */

import type { BrokerService } from '../broker/interface.js';
import type { RiskCheckConfig, RiskCheckDeps } from '../orders/risk-check.js';
import type { PositionFilters } from '../trades/filters.js';
import type { Trade } from '../db/schema.js';
import type { ResolvedPipelineDeps, ResolvedPendingContext } from './execute-resolved.js';
import { OrderManager } from '../orders/order-manager.js';
import { buildOrderCallbacks } from '../orders/build-order-callbacks.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { getTrader } from '../config/traders.js';
import { MAX_CONTRACTS } from '../config/risk-defaults.js';
import { checkRiskLimits } from '../orders/risk-check.js';
import { recordTrade } from '../trades/record-trade.js';
import { createEmitter } from '../decisions/emitter.js';
import { getTodayStartingBalance } from '../reconciliation/daily-balance.js';
import { safeParseFloat } from '../lib/numbers.js';
import { toDateKeyET } from '../lib/et-date.js';
import { isOpen, isClosed, notBacktest, forRun, forSymbol, forTrader, forStrategy } from '../trades/filters.js';
import { db, schema } from '../db/client.js';
import { and, eq, sql } from 'drizzle-orm';

// ─── Stable primitives ──────────────────────────────

export type TradeScope =
  | { kind: 'live' }
  | { kind: 'backtest'; backtestRunId: string };

/** Ambient environment — everything that varies between live and backtest
 *  that isn't the broker or config. */
export type Environment = {
  clock: () => Date;
  scope: TradeScope;
  sendAlert?: (params: { title: string; message: string; severity: 'critical' | 'warning' | 'info' }) => Promise<void> | void;
};

export type PipelineConfig = {
  riskConfig: RiskCheckConfig;
  agentIdentity: { provider: string; model: string };
  disableRiskLimits?: boolean;
  /** If provided, used as starting equity. Otherwise looked up from dailyBalances table. */
  startingEquity?: number;
  manualTick?: boolean;
};

// ─── Factory input/output ────────────────────────────

export type PipelineInfra = {
  broker: BrokerService;
  env: Environment;
  config: PipelineConfig;
};

export type PipelineBundle = {
  orderManager: OrderManager;
  pipelineDeps: ResolvedPipelineDeps;
  pendingIntents: Map<string, ResolvedPendingContext>;
  /** Get open positions (scope-filtered). Exposed for callers that need
   *  direct position access (e.g. expiry warnings, processTask getPositions). */
  getOpenPositions: (filters?: PositionFilters) => Promise<Trade[]>;
  destroy: () => void;
};

// ─── Factory ─────────────────────────────────────────

export function buildPipelineDeps(infra: PipelineInfra): PipelineBundle {
  const { broker, env, config } = infra;
  const { scope, clock } = env;

  // ── Scope filter (DB query scoping) ──
  const scopeFilter = scope.kind === 'backtest'
    ? forRun(scope.backtestRunId)
    : notBacktest;

  // ── getOpenPositions (derived from scope) ──
  const getOpenPositions = async (filters: PositionFilters = {}): Promise<Trade[]> => {
    const conditions = [isOpen, scopeFilter];
    if (filters.symbol) conditions.push(forSymbol(filters.symbol));
    if (filters.trader) conditions.push(forTrader(filters.trader));
    if (filters.strategy) conditions.push(forStrategy(filters.strategy));
    return db.select().from(schema.trades).where(and(...conditions));
  };

  // ── Pending intents ──
  const pendingIntents = new Map<string, ResolvedPendingContext>();

  // ── Emitter scope helper ──
  const createScopedEmitter = (messageId: string, taskId?: string) =>
    scope.kind === 'backtest'
      ? createEmitter({ messageId, backtestRunId: scope.backtestRunId })
      : createEmitter({ messageId, taskId });

  // ── OrderManager ──
  const callbackScope = scope.kind === 'backtest'
    ? { backtestRunId: scope.backtestRunId }
    : {};

  const orderManager = new OrderManager({
    broker,
    clock,
    manualTick: config.manualTick,
    ...buildOrderCallbacks({
      pendingIntents,
      createScopedEmitter,
      clock,
      scope: callbackScope,
      sendAlert: env.sendAlert as ((params: { title: string; message: string; severity: 'critical' | 'warning' }) => Promise<void>) | undefined,
    }),
  });

  // ── Risk deps (derived from scope + clock + broker) ──
  const riskDeps: RiskCheckDeps = {
    getOpenTrades: getOpenPositions,

    getDailyClosedPnl: async () => {
      const dateStr = scope.kind === 'backtest'
        ? toDateKeyET(clock())
        : undefined; // live uses date('now')

      const dateCondition = scope.kind === 'backtest'
        ? sql`closed_at LIKE ${dateStr + '%'}`
        : sql`closed_at >= date('now')`;

      const result = await db.select({
        total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
      }).from(schema.trades).where(and(
        isClosed, scopeFilter, dateCondition,
      ));
      return safeParseFloat(result[0]?.total);
    },

    getStartingEquity: async () => {
      if (config.startingEquity != null) return config.startingEquity;
      const bal = await getTodayStartingBalance();
      return bal?.equity ?? null;
    },

    getCurrentEquity: async () => {
      const balance = await broker.getAccountBalance();
      return balance.equity;
    },

    getReconciliationAlertCount: async () => {
      if (scope.kind === 'backtest') return 0;
      const alerts = await db.select({ count: sql<number>`COUNT(*)` })
        .from(schema.reconciliationAlerts)
        .where(and(
          eq(schema.reconciliationAlerts.resolved, false),
          eq(schema.reconciliationAlerts.type, 'DB_ONLY'),
        ));
      return alerts[0]?.count ?? 0;
    },

    getWorkingOrderExposure: () => orderManager.getExposure(),
  };

  // ── Pipeline deps ──
  const agentModel = `${config.agentIdentity.provider}:${config.agentIdentity.model}`;

  const pipelineDeps: ResolvedPipelineDeps = {
    broker,
    orderManager,

    calculatePositionSize: async (input) => {
      const tc = await getTrader(input.trader);
      const balance = await broker.getAccountBalance();
      const sizer = buildPositionSizer(tc?.positionSizingConfig);
      return sizer.calculateSize({
        symbol: input.symbol,
        strategy: input.strategy,
        entryPrice: input.entryPrice,
        equity: balance.equity,
        spreadMaxRisk: input.spreadMaxRisk,
        maxQuantity: MAX_CONTRACTS[input.strategy],
      });
    },

    checkRiskLimits: config.disableRiskLimits
      ? async () => ({
          allowed: true as boolean,
          dailyPnl: 0,
          openPositionsOnSymbol: 0,
          totalOpenPositions: 0,
          maxTotalPositions: 0,
          totalNotional: 0,
          maxNotional: 0,
          workingOrdersOnSymbol: 0,
          workingOrdersTotal: 0,
          workingOrderNotional: 0,
        })
      : (input) => checkRiskLimits(input, riskDeps, config.riskConfig),

    recordTrade: (input) => {
      const scopeFields = scope.kind === 'backtest'
        ? { backtestRunId: scope.backtestRunId, isBacktest: true }
        : { isBacktest: false };

      return recordTrade({
        ...input,
        ...scopeFields,
        metadata: { ...input.metadata, agentModel },
      });
    },

    onPending: (orderId, context) => {
      pendingIntents.set(orderId, context);
    },
  };

  // ── Destroy ──
  const destroy = () => {
    orderManager.destroy();
    pendingIntents.clear();
  };

  return { orderManager, pipelineDeps, pendingIntents, getOpenPositions, destroy };
}
