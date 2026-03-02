/**
 * Shared factory types for building pipeline dependencies.
 *
 * Defines the contract between runners (live/backtest) and the shared pipeline.
 * Each runner provides `RunnerInfra` (broker, clock, scoping) and gets back
 * a fully wired `ResolvedPipelineDeps` with identical business logic.
 *
 * The factory ensures parity: both paths use the same sizing (with spreadMaxRisk),
 * risk checking (with working order exposure), trade recording (with agentModel),
 * and orphan fill handling.
 */

import type { BrokerService } from '../broker/interface.js';
import type { OrderManager } from '../orders/order-manager.js';
import type { RiskCheckConfig, RiskCheckDeps } from '../orders/risk-check.js';
import type { PositionFilters } from '../trades/filters.js';
import type { Trade } from '../db/schema.js';

// ─── Runner Infrastructure ──────────────────────────────────────────

/** Discriminated union for trade/event scoping. */
export type TradeScope =
  | { kind: 'live'; getTaskId: () => string }
  | { kind: 'backtest'; backtestRunId: string };

/**
 * What each runner provides to the factory.
 *
 * Every field is REQUIRED (except `disableRiskLimits` which defaults to false).
 * The compiler forces every runner to explicitly provide every infra primitive.
 */
export type RunnerInfra = {
  // ── Core infra (different per environment) ──
  broker: BrokerService;
  orderManager: OrderManager;
  clock: () => Date;

  // ── Scoping (how trades/events are attributed) ──
  tradeScope: TradeScope;

  // ── Position data (different source per environment) ──
  getOpenPositions: (filters?: PositionFilters) => Promise<Trade[]>;

  // ── Risk deps (pre-built by each runner with its own data sources) ──
  riskDeps: RiskCheckDeps;
  riskConfig: RiskCheckConfig;
  disableRiskLimits?: boolean;

  // ── Agent identity ──
  agentIdentity: { provider: string; model: string };
};

/**
 * Guarantees enforced by the factory:
 *
 * 1. spreadMaxRisk ALWAYS forwarded to position sizer (both paths)
 * 2. agentModel ALWAYS recorded in trade metadata (both paths)
 * 3. onOrphanFill / onOrphanCancel wired identically (both paths)
 * 4. getReconciliationAlertCount + getWorkingOrderExposure required (both paths)
 * 5. orderManager + onPending required — no fallback branch
 *
 * The ONLY differences between live and backtest:
 * - broker implementation (liveService vs SimBroker)
 * - clock source (() => new Date() vs () => clock.now())
 * - trade scoping (taskId vs backtestRunId)
 * - position data source (DB query vs broker.getOpenTrades())
 * - risk config values (LIVE_RISK_DEFAULTS vs BACKTEST_RISK_DEFAULTS)
 * - risk dep data sources (real DB/broker queries vs sim clock/broker queries)
 * - disableRiskLimits (false for live, configurable for backtest)
 * - emitter scope per task (taskId vs backtestRunId)
 * - classifySkip / onResult (different post-processing logic)
 * - OrderManager config (manualTick, clock differ)
 */
