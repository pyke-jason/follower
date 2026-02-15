import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { runBacktest } from './runner.js';
import { printReport } from './report.js';
import { db, schema } from '../db/client.js';
import type { BacktestConfig } from './types.js';
import type { BacktestRunConfig } from '../db/schema.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.log('Usage: npm run backtest -- <start-date> <end-date> <traders> [--agent] [--max-agent-calls N] [--slippage N] [--quote-tape]');
    console.log('');
    console.log('Examples:');
    console.log('  npm run backtest -- 2025-09-01 2025-12-27 Arethra,Pete');
    console.log('  npm run backtest -- 2025-09-01 2025-12-27 Arethra,Pete --agent');
    console.log('  npm run backtest -- 2025-09-01 2025-12-27 Pete --agent --max-agent-calls 50');
    process.exit(1);
  }

  const startDate = new Date(args[0] + 'T00:00:00Z');
  const endDate = new Date(args[1] + 'T23:59:59Z');
  const traders = args[2].split(',').map((t) => t.trim());

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    console.error('Invalid date format. Use YYYY-MM-DD.');
    process.exit(1);
  }

  // Parse flags
  const useAgent = args.includes('--agent');
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

  const useQuoteTape = args.includes('--quote-tape');
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

  // Create backtest run row in DB
  const runConfig: BacktestRunConfig = {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    traders,
    useAgent,
    maxAgentCalls,
    slippagePct,
    useQuoteTape,
  };

  const runId = crypto.randomUUID();
  await db.insert(schema.backtestRuns).values({
    id: runId,
    status: 'PENDING',
    config: runConfig,
  });

  console.log(`[Backtest] Starting (run ${runId})...`);
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
