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
import type { PendingResumeData, ResolvedPipelineDeps, ResolvedPendingContext } from './execute-resolved.js';
import { createPendingContextFromResume } from './execute-resolved.js';
import { OrderManager } from '../orders/order-manager.js';
import { isHalted } from '../lib/halt-state.js';
import { buildOrderCallbacks } from '../orders/build-order-callbacks.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { getTrader } from '../config/traders.js';
import { MAX_CONTRACTS, SHORT_OPTION_CUSHION_WARN, SHORT_OPTION_CUSHION_BLOCK } from '../config/risk-defaults.js';
import { checkRiskLimits } from '../orders/risk-check.js';
import { recordTrade, recordCancelledOpen } from '../trades/record-trade.js';
import { createEmitter } from '../decisions/emitter.js';
import { getTodayStartingBalance } from '../reconciliation/daily-balance.js';
import { safeParseFloat } from '../lib/numbers.js';
import { toDateKeyET } from '../lib/et-date.js';
import { HaltTracker } from '../lib/halt-tracker.js';
import { MarketGuard } from '../lib/market-guard.js';
import { isOpen, isClosed, forChannel, forSymbol, forTrader, forStrategy } from '../trades/filters.js';
import { db, schema } from '../db/client.js';
import { and, eq, sql } from 'drizzle-orm';

// ─── Stable primitives ──────────────────────────────

/** channelId string — e.g. 'live:U14368257', 'bt:<runId>', 'paper:DU12345'. */
export type TradeScope = string;

/** Ambient environment — everything that varies between live and backtest
 *  that isn't the broker or config. */
type Environment = {
  clock: () => Date;
  scope: TradeScope;
  sendAlert?: (params: { title: string; message: string; severity: 'critical' | 'warning' | 'info'; cooldownKey?: string }) => Promise<void> | void;
};

type PipelineConfig = {
  riskConfig: RiskCheckConfig;
  agentIdentity: { provider: string; model: string };
  disableRiskLimits?: boolean;
  /** If provided, used as starting equity. Otherwise looked up from dailyBalances table. */
  startingEquity?: number;
  manualTick?: boolean;
  skipReconciliationCheck?: boolean;
  isBacktestScope?: boolean;
  requireExplicitTimestamps?: boolean;
};

// ─── Factory input/output ────────────────────────────

type PipelineInfra = {
  broker: BrokerService;
  env: Environment;
  config: PipelineConfig;
  initialPendingIntents?: Array<{ orderId: string; context: PendingResumeData }>;
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
  const scopeFilter = forChannel(scope);

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
  const createScopedEmitter = (messageId?: string, taskId?: string) =>
    createEmitter({ messageId, channelId: scope, taskId });

  // ── OrderManager ──
  const orderManager = new OrderManager({
    broker,
    clock,
    manualTick: config.manualTick,
    haltCheck: config.isBacktestScope ? undefined : isHalted,
    ...buildOrderCallbacks({
      pendingIntents,
      createScopedEmitter,
      clock,
      scope: { channelId: scope },
      recordCancelledOpen: (input) => recordCancelledOpen({
        ...input,
        channelId: scope,
        agentModel,
      }),
      sendAlert: env.sendAlert as ((params: { title: string; message: string; severity: 'critical' | 'warning' }) => Promise<void>) | undefined,
    }),
  });

  // ── Risk deps (derived from scope + clock + broker) ──
  const riskDeps: RiskCheckDeps = {
    getOpenTrades: getOpenPositions,

    getDailyClosedPnl: async () => {
      const dateStr = toDateKeyET(clock());
      const dateCondition = sql`closed_at LIKE ${dateStr + '%'}`;

      const result = await db.select({
        total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
      }).from(schema.trades).where(and(
        isClosed, scopeFilter, dateCondition,
      ));
      return safeParseFloat(result[0]?.total);
    },

    getStartingEquity: async () => {
      if (config.startingEquity != null) return config.startingEquity;
      const bal = await getTodayStartingBalance(scope);
      return bal?.equity ?? null;
    },

    getCurrentEquity: async () => {
      const balance = await broker.getAccountBalance();
      return balance.equity;
    },

    getMaintenanceMargin: async () => {
      const balance = await broker.getAccountBalance();
      return balance.maintenanceMargin ?? null;
    },

    getReconciliationAlertCount: (config.skipReconciliationCheck ?? config.isBacktestScope ?? false)
      ? async () => 0
      : async () => {
          // Block on all drift types: DB_ONLY, BROKER_ONLY, QUANTITY_MISMATCH.
          // Any unresolved discrepancy is unsafe for new position opens.
          const alerts = await db.select({ count: sql<number>`COUNT(*)` })
            .from(schema.reconciliationAlerts)
            .where(and(
              eq(schema.reconciliationAlerts.channelId, scope),
              eq(schema.reconciliationAlerts.resolved, false),
            ));
          return alerts[0]?.count ?? 0;
        },

    getWorkingOrderExposure: () => orderManager.getExposure(),
  };

  // ── Market guard ──
  // Backtest gets a disabled guard so the pipeline can call it unconditionally
  // (no path-specific `if (deps.marketGuard)` branch in shared executor code).
  const marketGuard = config.isBacktestScope
    ? MarketGuard.disabled()
    : new MarketGuard(new HaltTracker(), clock);

  // ── Pipeline deps ──
  const agentModel = `${config.agentIdentity.provider}:${config.agentIdentity.model}`;

  const pipelineDeps: ResolvedPipelineDeps = {
    broker,
    orderManager,
    sendAlert: env.sendAlert,

    calculatePositionSize: async (input) => {
      const tc = await getTrader(input.trader);
      const balance = await broker.getAccountBalance();

      // Warn before placing naked short options if margin cushion is thin.
      // cushion = (equity - maintenanceMargin) / equity; below 10% is danger territory.
      const isNakedShort = (input.strategy === 'CALL' || input.strategy === 'PUT') && input.direction === 'SHORT';
      if (isNakedShort && balance.cushion != null) {
        if (balance.cushion < SHORT_OPTION_CUSHION_BLOCK) {
          void env.sendAlert?.({
            title: `Margin cushion critical — blocking naked short ${input.strategy}`,
            message: `Account cushion is ${(balance.cushion * 100).toFixed(1)}% (below ${(SHORT_OPTION_CUSHION_BLOCK * 100).toFixed(0)}% block threshold). Order for ${input.symbol} will not be placed.`,
            severity: 'critical',
          });
          return { quantity: 0, reasoning: `margin cushion ${(balance.cushion * 100).toFixed(1)}% below ${(SHORT_OPTION_CUSHION_BLOCK * 100).toFixed(0)}% block threshold`, riskPerTrade: 0 };
        }
        if (balance.cushion < SHORT_OPTION_CUSHION_WARN) {
          void env.sendAlert?.({
            title: `Low margin cushion — naked short ${input.strategy}`,
            message: `Account cushion is ${(balance.cushion * 100).toFixed(1)}% (below ${(SHORT_OPTION_CUSHION_WARN * 100).toFixed(0)}% warning threshold). Proceeding with ${input.symbol} but monitor closely.`,
            severity: 'warning',
          });
        }
      }

      const sizer = buildPositionSizer(tc?.positionSizingConfig);
      return sizer.calculateSize({
        symbol: input.symbol,
        strategy: input.strategy,
        direction: input.direction,
        entryPrice: input.entryPrice,
        equity: balance.equity,
        legs: input.legs,
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
      return recordTrade({
        ...input,
        sendAlert: env.sendAlert,
        channelId: scope,
        requireExplicitTimestamps: config.requireExplicitTimestamps,
        metadata: { ...input.metadata, agentModel },
      });
    },

    onPending: (orderId, context) => {
      pendingIntents.set(orderId, context);
    },

    marketGuard,
  };

  for (const pending of infra.initialPendingIntents ?? []) {
    pendingIntents.set(
      pending.orderId,
      createPendingContextFromResume(pending.context, pipelineDeps.recordTrade),
    );
  }

  // ── Destroy ──
  const destroy = () => {
    orderManager.destroy();
    pendingIntents.clear();
  };

  return { orderManager, pipelineDeps, pendingIntents, getOpenPositions, destroy };
}
