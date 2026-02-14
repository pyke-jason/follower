/**
 * Lightweight backtest launcher used by the web UI.
 * Accepts --run-id to reuse an existing backtest_runs row
 * (the web action creates the row before spawning this process).
 */
import 'dotenv/config';
import { runBacktest } from './runner.js';
import { printReport } from './report.js';
import type { BacktestConfig } from './types.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('Usage: tsx src/backtest/launch.ts <start-date> <end-date> <traders> [--agent] [--max-agent-calls N] [--slippage N] [--quote-tape] [--run-id ID]');
    process.exit(1);
  }

  const startDate = new Date(args[0] + 'T00:00:00Z');
  const endDate = new Date(args[1] + 'T23:59:59Z');
  const traders = args[2].split(',').map((t) => t.trim());

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    console.error('Invalid date format. Use YYYY-MM-DD.');
    process.exit(1);
  }

  const useAgent = args.includes('--agent');
  const useQuoteTape = args.includes('--quote-tape');
  let maxAgentCalls = 100;
  const maxAgentIdx = args.indexOf('--max-agent-calls');
  if (maxAgentIdx !== -1 && args[maxAgentIdx + 1]) {
    maxAgentCalls = parseInt(args[maxAgentIdx + 1]);
  }

  let slippagePct = 0.01;
  const slippageIdx = args.indexOf('--slippage');
  if (slippageIdx !== -1 && args[slippageIdx + 1]) {
    slippagePct = parseFloat(args[slippageIdx + 1]);
  }

  let runId: string | undefined;
  const runIdIdx = args.indexOf('--run-id');
  if (runIdIdx !== -1 && args[runIdIdx + 1]) {
    runId = args[runIdIdx + 1];
  }

  const databentoApiKey = process.env.DATABENTO_API_KEY;
  if (useQuoteTape && !databentoApiKey) {
    console.error('DATABENTO_API_KEY env var is required when using --quote-tape');
    process.exit(1);
  }

  const config: BacktestConfig = {
    startDate,
    endDate,
    traders,
    useAgent,
    maxAgentCalls,
    slippagePct,
    useQuoteTape,
    databentoApiKey,
    databentoDataset: process.env.DATABENTO_DATASET ?? 'DBEQ.BASIC',
  };

  console.log(`[Backtest] Starting (run ${runId ?? 'no-id'})...`);
  const startTime = Date.now();

  const report = await runBacktest(config, runId);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Backtest] Completed in ${elapsed}s`);

  printReport(report);
}

main().catch((err) => {
  console.error('[Backtest] Fatal error:', err);
  process.exit(1);
});
