import { loadSecrets } from '../src/lib/secrets/index.js';
import { createFixtureSource } from '../src/intents/evals/sources/fixture.js';
import { scoreCase, PASS_THRESHOLD } from '../src/intents/evals/scorer.js';
import { printReport } from '../src/intents/evals/reporter.js';
import { resolveOrchestrator } from '../src/intents/orchestrator/index.js';
import type { OrchestratorEnv } from '../src/intents/orchestrator/types.js';
import type { Message } from '../src/db/schema.js';
import type { BrokerService } from '../src/broker/interface.js';
import { DatabentoMarketDataProvider } from '../src/backtest/market-data.js';
import { tickCacheDb } from '../src/db/tick-cache-client.js';
import { createProvider } from '../src/agent/providers.js';
import type { LLMProvider } from '../src/agent/providers.js';
import type { EvalCase, EvalRunResult, EvalResult } from '../src/intents/evals/types.js';
import { htmlToCleanText } from '../src/parsing/html.js';
import { extractBadges } from '../src/parsing/badges.js';
import { extractSymbols } from '../src/parsing/symbols.js';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    tag: { type: 'string' },
    case: { type: 'string' },
    provider: { type: 'string', default: 'xai' },
    model: { type: 'string', default: 'grok-4-1-fast-non-reasoning' },
  },
  strict: false,
});

async function main() {
  await loadSecrets();
  const source = createFixtureSource();
  let cases = await source.load();

  if (args.case) {
    cases = cases.filter(c => c.id === args.case);
    if (cases.length === 0) { console.error(`No case found: ${args.case}`); process.exit(1); }
  }
  if (args.tag) {
    cases = cases.filter(c => c.tags?.includes(args.tag!));
    if (cases.length === 0) { console.error(`No cases with tag: ${args.tag}`); process.exit(1); }
  }

  const providerName = args.provider as 'anthropic' | 'xai';
  const modelName = args.model!;

  // LLM provider is lazy — skip cases don't need it
  let llmProvider: LLMProvider | undefined;
  async function getProvider(): Promise<LLMProvider> {
    if (!llmProvider) {
      llmProvider = await createProvider({ provider: providerName, model: modelName });
    }
    return llmProvider;
  }

  const apiKey = process.env.DATABENTO_API_KEY;
  const marketDataProvider = apiKey
    ? new DatabentoMarketDataProvider(apiKey, tickCacheDb)
    : null;

  const CONCURRENCY = 8;
  console.log(`Running ${cases.length} cases (${providerName}/${modelName}, concurrency=${CONCURRENCY})...\n`);

  // Ensure LLM provider is initialized before parallel work
  const provider = await getProvider();

  async function runCase(evalCase: EvalCase): Promise<EvalResult> {
    const start = Date.now();
    const input = evalCase.input;
    const timestamp = input.timestamp ?? '2025-09-05T14:00:00.000Z';
    const at = new Date(timestamp);

    const { rawHtml } = input;
    const cleanText = htmlToCleanText(rawHtml);
    const { badges } = extractBadges(rawHtml);
    const symbols = extractSymbols(rawHtml);

    const message: Message = {
      id: evalCase.id,
      author: input.author ?? 'testTrader',
      timestamp,
      rawHtml,
      cleanText,
      badges,
      symbols,
      actionHint: null,
      directionHint: null,
      detectedStrategies: [],
      isPaperTrade: false,
      confidence: null,
      ingestedAt: new Date().toISOString(),
    };

    const broker: BrokerService = {
      getQuote: (symbol) => marketDataProvider!.getQuote(symbol, at),
      placeOrder: async () => { throw new Error('not used in evals'); },
      modifyOrder: async () => { throw new Error('not used in evals'); },
      cancelOrder: async () => { throw new Error('not used in evals'); },
      getOrderStatus: async () => { throw new Error('not used in evals'); },
      getPositions: async () => [],
      getAccountBalance: async () => { throw new Error('not used in evals'); },
    };

    const env: OrchestratorEnv = {
      getPositions: async () => input.positions ?? [],
      llm: provider,
      broker,
      emitter: { emit: async () => {} },
    };

    try {
      const orchestratorResult = await resolveOrchestrator(message, env);
      const evalResult = scoreCase(evalCase, orchestratorResult, at);
      evalResult.durationMs = Date.now() - start;

      const status = evalResult.passed ? 'PASS' : 'FAIL';
      console.log(`  ${status}  ${evalCase.id} (${evalResult.durationMs}ms)`);
      return evalResult;
    } catch (err) {
      const result: EvalResult = {
        caseId: evalCase.id,
        description: evalCase.description,
        passed: false,
        hardFail: false,
        score: 0,
        fieldScores: [],
        hardFailFields: [],
        actualDecision: 'ERROR',
        expectedDecision: evalCase.expected.outcome,
        actualSignals: [],
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        tags: evalCase.tags ?? [],
      };
      console.log(`  ERR   ${evalCase.id}: ${err instanceof Error ? err.message : err}`);
      return result;
    }
  }

  // Bounded-concurrency pool
  const results: EvalResult[] = [];
  const queue = [...cases];
  async function worker() {
    while (queue.length > 0) {
      const evalCase = queue.shift()!;
      results.push(await runCase(evalCase));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, () => worker()));

  // Build summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  const hardFails = results.filter(r => r.hardFail).length;
  const avgScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.score, 0) / results.length
    : 0;

  const byTag: Record<string, { total: number; passed: number; passRate: number }> = {};
  for (const r of results) {
    for (const tag of r.tags) {
      if (!byTag[tag]) byTag[tag] = { total: 0, passed: 0, passRate: 0 };
      byTag[tag].total++;
      if (r.passed) byTag[tag].passed++;
    }
  }
  for (const stats of Object.values(byTag)) {
    stats.passRate = stats.total > 0 ? stats.passed / stats.total : 0;
  }

  const runResult: EvalRunResult = {
    runId: randomUUID(),
    promptHash: 'orchestrator-v1',
    model: modelName,
    provider: providerName,
    timestamp: new Date().toISOString(),
    source: source.name,
    cases: results,
    summary: {
      total: results.length,
      passed,
      failed,
      hardFails,
      passRate: results.length > 0 ? passed / results.length : 0,
      avgScore,
      byTag,
    },
  };

  printReport(runResult);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
