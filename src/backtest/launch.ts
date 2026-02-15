/**
 * Backtest launcher — single CLI entry point.
 * When --run-id is provided (web UI), reuses an existing backtest_runs row.
 * Otherwise, creates a new DB row automatically (CLI usage).
 */
import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { runBacktest } from './runner.js';
import { printReport } from './report.js';
import { setLogLevel, createLogger } from '../lib/logger.js';
import type { LogLevel } from '../lib/logger.js';
import type { BacktestConfig, FillModel } from './types.js';
import { db, schema } from '../db/client.js';
import type { BacktestRunConfig } from '../db/schema.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('Usage: tsx src/backtest/launch.ts <start-date> <end-date> <traders> [--fill-model orats|midpoint|natural] [--quote-tape] [--agent-provider NAME] [--agent-model NAME] [--refresh-quote-cache] [--log-level debug|info|warn|error] [--run-id ID]');
    process.exit(1);
  }

  const startDate = new Date(args[0] + 'T00:00:00Z');
  const endDate = new Date(args[1] + 'T23:59:59Z');
  const traders = args[2].split(',').map((t) => t.trim());

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    console.error('Invalid date format. Use YYYY-MM-DD.');
    process.exit(1);
  }

  const useDatabento = args.includes('--quote-tape');

  let fillModel: FillModel = 'orats';
  const fillModelIdx = args.indexOf('--fill-model');
  if (fillModelIdx !== -1 && args[fillModelIdx + 1]) {
    const val = args[fillModelIdx + 1] as FillModel;
    if (!['orats', 'midpoint', 'natural'].includes(val)) {
      console.error(`Invalid fill model "${val}". Must be one of: orats, midpoint, natural`);
      process.exit(1);
    }
    fillModel = val;
  }

  let agentProvider: string | undefined;
  const providerIdx = args.indexOf('--agent-provider');
  if (providerIdx !== -1 && args[providerIdx + 1]) {
    agentProvider = args[providerIdx + 1];
  }

  let agentModel: string | undefined;
  const modelIdx = args.indexOf('--agent-model');
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    agentModel = args[modelIdx + 1];
  }

  const refreshQuoteCache = args.includes('--refresh-quote-cache');

  let logLevel: LogLevel = 'debug';
  const logLevelIdx = args.indexOf('--log-level');
  if (logLevelIdx !== -1 && args[logLevelIdx + 1]) {
    const val = args[logLevelIdx + 1] as LogLevel;
    if (!['debug', 'info', 'warn', 'error'].includes(val)) {
      console.error(`Invalid log level "${val}". Must be one of: debug, info, warn, error`);
      process.exit(1);
    }
    logLevel = val;
  }
  setLogLevel(logLevel);

  let runId: string | undefined;
  const runIdIdx = args.indexOf('--run-id');
  if (runIdIdx !== -1 && args[runIdIdx + 1]) {
    runId = args[runIdIdx + 1];
  }

  // Auto-create DB run row when launched from CLI (no --run-id)
  if (!runId) {
    runId = crypto.randomUUID();
    const runConfig: BacktestRunConfig = {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      traders,
      useQuoteTape: useDatabento,
    };
    await db.insert(schema.backtestRuns).values({
      id: runId,
      status: 'PENDING',
      config: runConfig,
    });
  }

  const databentoApiKey = process.env.DATABENTO_API_KEY;
  if (useDatabento && !databentoApiKey) {
    console.error('DATABENTO_API_KEY env var is required when using --quote-tape');
    process.exit(1);
  }

  const config: BacktestConfig = {
    startDate,
    endDate,
    traders,
    fillModel,
    databentoApiKey: useDatabento ? databentoApiKey : undefined,
    databentoDataset: process.env.DATABENTO_DATASET ?? 'DBEQ.BASIC',
    agentProvider,
    agentModel,
    refreshQuoteCache,
    logLevel,
  };

  const log = createLogger('Backtest');
  log.info(`Starting (run ${runId ?? 'no-id'})...`);
  const startTime = Date.now();

  const report = await runBacktest(config, runId);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Completed in ${elapsed}s`);

  printReport(report);
}

process.on('SIGTERM', () => {
  createLogger('Backtest').info('Received SIGTERM, exiting.');
  process.exit(0);
});

main().catch((err) => {
  createLogger('Backtest').error('Fatal error:', err);
  process.exit(1);
});
