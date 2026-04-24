import { randomUUID } from 'node:crypto';
import { createAgent } from '@/agent/factory.js';
import type { Agent, ModelProvider } from '@/agent/result.js';
import type { BrokerService } from '@/broker/interface.js';
import { DatabentoMarketDataProvider } from '@/backtest/market-data.js';
import type { Message } from '@/db/schema.js';
import { htmlToCleanText } from '@/parsing/html.js';
import { extractBadges } from '@/parsing/badges.js';
import { extractSymbols } from '@/parsing/symbols.js';
import { STUB_BROKER } from '@/classify/stub-broker.js';
import { formatChatContext } from '../trader-context.js';
import { resolveOrchestrator } from '../orchestrator/index.js';
import type { ChatHistoryProvider, OrchestratorEnv } from '../orchestrator/types.js';
import { INTENT_VERSION } from '../orchestrator/intent-cache.js';
import { createFixtureSource } from './sources/fixture.js';
import { scoreCase } from './scorer.js';
import type {
  EvalCase,
  EvalChatHistoryMessage,
  EvalResult,
  EvalRunResult,
} from './types.js';

type FixtureRunOptions = {
  provider: ModelProvider;
  model: string;
  tag?: string;
  caseId?: string;
  concurrency?: number;
  logProgress?: boolean;
};

async function loadFixtureCases(options: Pick<FixtureRunOptions, 'tag' | 'caseId'> = {}): Promise<EvalCase[]> {
  const source = createFixtureSource();
  let cases = await source.load();

  if (options.caseId) {
    cases = cases.filter(c => c.id === options.caseId);
    if (cases.length === 0) throw new Error(`No case found: ${options.caseId}`);
  }
  if (options.tag) {
    cases = cases.filter(c => c.tags?.includes(options.tag!));
    if (cases.length === 0) throw new Error(`No cases with tag: ${options.tag}`);
  }

  return cases;
}

export async function runFixtureEvalSuite(options: FixtureRunOptions): Promise<EvalRunResult> {
  const cases = await loadFixtureCases(options);
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const agent = await createAgent({ provider: options.provider, model: options.model });
  const queue = [...cases];
  const results: EvalResult[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const evalCase = queue.shift();
      if (!evalCase) break;
      const result = await runFixtureCase(evalCase, agent);
      results.push(result);
      if (options.logProgress) {
        const status = result.passed ? 'PASS' : result.error ? 'ERR ' : 'FAIL';
        console.log(`  ${status}  ${evalCase.id} (${result.durationMs}ms)`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));
  return buildEvalRunResult({
    provider: options.provider,
    model: options.model,
    cases: results.sort((a, b) => a.caseId.localeCompare(b.caseId)),
  });
}

async function runFixtureCase(
  evalCase: EvalCase,
  agent: Agent,
): Promise<EvalResult> {
  const start = Date.now();
  const input = evalCase.input;
  const timestamp = input.timestamp ?? '2025-09-05T14:00:00.000Z';
  const at = new Date(timestamp);
  const message = evalInputToMessage(evalCase.id, input.rawHtml, {
    author: input.author,
    timestamp,
  });

  const env: OrchestratorEnv = {
    getPositions: async () => input.positions ?? [],
    agent,
    broker: await createEvalBroker(at),
    emitter: { emit: async () => {} },
    chatHistory: createFixtureChatHistoryProvider(input.chatHistory ?? [], {
      defaultAuthor: input.author ?? 'testTrader',
      defaultTimestamp: timestamp,
    }),
  };

  try {
    const orchestratorResult = await resolveOrchestrator(message, env);
    const evalResult = scoreCase(evalCase, orchestratorResult, at);
    evalResult.durationMs = Date.now() - start;
    return evalResult;
  } catch (err) {
    return {
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
  }
}

export function evalInputToMessage(
  id: string,
  rawHtml: string,
  opts: { author?: string; timestamp?: string } = {},
): Message {
  const cleanText = htmlToCleanText(rawHtml);
  return {
    id,
    author: opts.author ?? 'testTrader',
    timestamp: opts.timestamp ?? '2025-09-05T14:00:00.000Z',
    rawHtml,
    cleanText,
    badges: extractBadges(rawHtml).badges,
    symbols: extractSymbols(rawHtml),
    actionHint: null,
    directionHint: null,
    detectedStrategies: [],
    isPaperTrade: false,
    confidence: null,
    ingestedAt: new Date().toISOString(),
    contentHash: null,
    reactions: [],
  };
}

export function createFixtureChatHistoryProvider(
  history: EvalChatHistoryMessage[],
  opts: { defaultAuthor: string; defaultTimestamp: string },
): ChatHistoryProvider {
  const messages = history
    .map((h, index) => evalInputToMessage(`fixture-history-${index}`, h.rawHtml, {
      author: h.author ?? opts.defaultAuthor,
      timestamp: h.timestamp ?? opts.defaultTimestamp,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    getRecentMessages: async (author?: string, limit = 20) => {
      const filtered = author
        ? messages.filter(m => m.author.toLowerCase() === author.toLowerCase())
        : messages;
      return formatChatContext(filtered.slice(-limit));
    },
  };
}

async function createEvalBroker(at: Date): Promise<BrokerService> {
  const apiKey = process.env.DATABENTO_API_KEY;
  const { tickCacheStore } = await import('@/db/tick-cache-client.js');
  const marketDataProvider = apiKey
    ? new DatabentoMarketDataProvider(apiKey, tickCacheStore)
    : null;

  if (!marketDataProvider) return STUB_BROKER;

  return {
    ...STUB_BROKER,
    getQuote: (symbol) => marketDataProvider.getQuote(symbol, at),
  };
}

function buildEvalRunResult(params: {
  provider: string;
  model: string;
  cases: EvalResult[];
}): EvalRunResult {
  const passed = params.cases.filter(r => r.passed).length;
  const failed = params.cases.length - passed;
  const hardFails = params.cases.filter(r => r.hardFail).length;
  const avgScore = params.cases.length > 0
    ? params.cases.reduce((sum, r) => sum + r.score, 0) / params.cases.length
    : 0;

  const byTag: Record<string, { total: number; passed: number; passRate: number }> = {};
  for (const r of params.cases) {
    for (const tag of r.tags) {
      if (!byTag[tag]) byTag[tag] = { total: 0, passed: 0, passRate: 0 };
      byTag[tag].total++;
      if (r.passed) byTag[tag].passed++;
    }
  }
  for (const stats of Object.values(byTag)) {
    stats.passRate = stats.total > 0 ? stats.passed / stats.total : 0;
  }

  return {
    runId: randomUUID(),
    promptHash: `orchestrator-v${INTENT_VERSION}`,
    model: params.model,
    provider: params.provider,
    timestamp: new Date().toISOString(),
    source: 'fixtures',
    cases: params.cases,
    summary: {
      total: params.cases.length,
      passed,
      failed,
      hardFails,
      passRate: params.cases.length > 0 ? passed / params.cases.length : 0,
      avgScore,
      byTag,
    },
  };
}
