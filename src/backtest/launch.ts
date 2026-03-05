/**
 * Backtest launcher — single CLI entry point.
 * When --run-id is provided (web UI), reuses an existing backtest_runs row.
 * Otherwise, creates a new DB row automatically (CLI usage).
 */
import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { runBacktest } from './runner.js';
import { printReport } from './report.js';
import { setLogLevel, createLogger, LogLevelSchema } from '../lib/logger.js';
import type { BacktestConfig } from './types.js';
import { FillModelSchema } from './types.js';
import { db, schema } from '../db/client.js';
import { DEFAULT_STARTING_EQUITY, DEFAULT_COMMISSION_SCHEDULE } from '../config/risk-defaults.js';


function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('Usage: tsx src/backtest/launch.ts <start-date> <end-date> <traders> [--fill-model orats|midpoint|natural] [--agent-provider NAME] [--agent-model NAME] [--refresh-quote-cache] [--log-level debug|info|warn|error] [--run-id ID] [--disable-risk-limits] [--max-on-symbol N] [--max-total-positions N]');
    process.exit(1);
  }

  const startDate = new Date(args[0] + 'T00:00:00Z');
  const endDate = new Date(args[1] + 'T23:59:59Z');
  const traders = args[2].split(',').map((t) => t.trim());

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    console.error('Invalid date format. Use YYYY-MM-DD.');
    process.exit(1);
  }

  const startDateIso = startDate.toISOString();
  const endDateIso = endDate.toISOString();
  const fillModelArg = parseArg(args, '--fill-model');
  const fillModelResult = FillModelSchema.safeParse(fillModelArg ?? 'orats');
  if (!fillModelResult.success) {
    console.error(`Invalid fill model "${fillModelArg}". Must be one of: orats, midpoint, natural`);
    process.exit(1);
  }
  const fillModel = fillModelResult.data;

  const agentProvider = parseArg(args, '--agent-provider');
  const agentModel = parseArg(args, '--agent-model');
  const refreshQuoteCache = args.includes('--refresh-quote-cache');
  const disableRiskLimits = args.includes('--disable-risk-limits');

  const maxOnSymbolArg = parseArg(args, '--max-on-symbol');
  const maxTotalPositionsArg = parseArg(args, '--max-total-positions');
  const maxDrawdownPctArg = parseArg(args, '--max-drawdown-pct');
  const maxAgentCallsArg = parseArg(args, '--max-agent-calls');
  const startingEquityArg = parseArg(args, '--starting-equity');
  const commissionOptionArg = parseArg(args, '--commission-option');
  const commissionStockArg = parseArg(args, '--commission-stock');

  const logLevelArg = parseArg(args, '--log-level');
  const logLevelResult = LogLevelSchema.safeParse(logLevelArg ?? 'info');
  if (!logLevelResult.success) {
    console.error(`Invalid log level "${logLevelArg}". Must be one of: debug, info, warn, error`);
    process.exit(1);
  }
  const logLevel = logLevelResult.data;
  setLogLevel(logLevel);

  let runId = parseArg(args, '--run-id');

  const config: BacktestConfig = {
    startDate: startDateIso,
    endDate: endDateIso,
    traders,
    useQuoteTape: true,
    fillModel,
    databentoApiKey: process.env.DATABENTO_API_KEY,
    databentoDataset: process.env.DATABENTO_DATASET ?? 'DBEQ.BASIC',
    agentProvider,
    agentModel,
    refreshQuoteCache,
    logLevel,
    disableRiskLimits: disableRiskLimits || undefined,
    ...(maxOnSymbolArg ? { maxOnSymbol: parseInt(maxOnSymbolArg, 10) } : {}),
    ...(maxTotalPositionsArg ? { maxTotalPositions: parseInt(maxTotalPositionsArg, 10) } : {}),
    ...(maxDrawdownPctArg ? { maxDrawdownPct: parseFloat(maxDrawdownPctArg) } : {}),
    ...(maxAgentCallsArg ? { maxAgentCalls: parseInt(maxAgentCallsArg, 10) } : {}),
    startingEquity: startingEquityArg ? parseInt(startingEquityArg, 10) : DEFAULT_STARTING_EQUITY,
    commissionSchedule: {
      option: { perContract: commissionOptionArg ? parseFloat(commissionOptionArg) : DEFAULT_COMMISSION_SCHEDULE.option.perContract },
      stock: { perShare: commissionStockArg ? parseFloat(commissionStockArg) : DEFAULT_COMMISSION_SCHEDULE.stock.perShare },
    },
  };

  if (!config.databentoApiKey) {
    console.error('DATABENTO_API_KEY env var is required.');
    process.exit(1);
  }

  // Auto-create DB run row when launched from CLI (no --run-id)
  if (!runId) {
    runId = crypto.randomUUID();
    await db.insert(schema.backtestRuns).values({
      id: runId,
      status: 'PENDING',
      config,
    });
  }

  const log = createLogger('BacktestLaunch');
  log.info(`Starting (run ${runId ?? 'no-id'})...`);
  const startTime = Date.now();

  const report = await runBacktest(config, runId);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Completed in ${elapsed}s`);

  printReport(report);
}

process.on('SIGTERM', () => {
  createLogger('BacktestLaunch').info('Received SIGTERM, exiting.');
  process.exit(0);
});

main().catch((err) => {
  createLogger('BacktestLaunch').error('Fatal error:', err);
  process.exit(1);
});
