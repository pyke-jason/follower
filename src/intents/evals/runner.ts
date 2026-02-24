import { createHash } from 'crypto';
import type { EvalCase, EvalSource, EvalResult, EvalRunResult } from './types.js';
import { scoreCase } from './scorer.js';
import { getVersion, DEFAULT_VERSION } from '../versions.js';
import type { IntentPipelineVersion } from '../versions.js';
import type { SignalContext } from '../postprocess.js';
import type { Signal } from '../../agent/schemas.js';
import { createProvider } from '../../agent/providers.js';
import type { LLMProvider } from '../../agent/providers.js';
import type { TaskContext } from '../../db/schema.js';
import { buildIntentPrompt, createIntentTools, runIntentPipeline } from '../extract-intent.js';

export type RunEvalOptions = {
  model: string;
  provider: 'anthropic' | 'xai';
  concurrency?: number;
  filter?: (c: EvalCase) => boolean;
  temperature?: number; // default: 0 (deterministic for reproducible evals)
  version?: string;
};

async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    function next() {
      while (active < limit && index < tasks.length) {
        const taskIndex = index++;
        active++;
        tasks[taskIndex]()
          .then((result) => {
            results[taskIndex] = result;
            active--;
            if (index >= tasks.length && active === 0) {
              resolve(results);
            } else {
              next();
            }
          })
          .catch(reject);
      }
    }
    if (tasks.length === 0) {
      resolve(results);
    } else {
      next();
    }
  });
}

async function runSingleCase(
  evalCase: EvalCase,
  provider: LLMProvider,
  temperature: number,
  version: IntentPipelineVersion,
): Promise<EvalResult> {
  const startMs = Date.now();

  const refDate = evalCase.input.timestamp
    ? new Date(evalCase.input.timestamp)
    : new Date('2025-09-05T14:00:00.000Z');

  const signalCtx: SignalContext = {
    cleanText: evalCase.input.message,
    badges: evalCase.input.badges ?? [],
    symbols: evalCase.input.symbols ?? [],
  };

  const taskContext: TaskContext = {
    messageId: `eval-${evalCase.id}`,
    messageTimestamp: evalCase.input.timestamp ?? '2025-09-05T14:00:00.000Z',
    author: evalCase.input.author ?? 'testTrader',
    cleanText: evalCase.input.message,
    badges: evalCase.input.badges ?? [],
    symbols: evalCase.input.symbols ?? [],
    actionHint: null,
    directionHint: null,
  };

  let actual: { decision: string; signals?: Signal[] } = { decision: 'ERROR', signals: [] };
  let errorMsg: string | undefined;

  try {
    const tools = createIntentTools(async () => '(eval mode: no chat history available)');
    const userPrompt = buildIntentPrompt(taskContext, [], null, {});
    const pipeline = await runIntentPipeline(signalCtx, userPrompt, tools, version, provider, temperature);

    if (pipeline.result) {
      actual = { decision: pipeline.result.decision, signals: pipeline.result.signals };
    } else {
      actual = { decision: 'ERROR', signals: [] };
      errorMsg = 'Agent returned no result';
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    actual = { decision: 'ERROR', signals: [] };
  }

  const durationMs = Date.now() - startMs;
  const scored = scoreCase(evalCase, actual, refDate);

  return {
    ...scored,
    durationMs,
    ...(errorMsg != null ? { error: errorMsg } : {}),
  };
}

export async function runEvals(
  source: EvalSource,
  opts: RunEvalOptions,
): Promise<EvalRunResult> {
  const allCases = await source.load();
  const cases = opts.filter ? allCases.filter(opts.filter) : allCases;

  const version = opts.version ? getVersion(opts.version) : DEFAULT_VERSION;
  const promptHash = createHash('sha256').update(version.systemPrompt).digest('hex').slice(0, 16);
  const provider = await createProvider({ provider: opts.provider, model: opts.model });
  const concurrency = opts.concurrency ?? 4;
  const temperature = opts.temperature ?? 0;

  const tasks = cases.map((c) => () => runSingleCase(c, provider, temperature, version));
  const results = await withConcurrency(tasks, concurrency);

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const hardFails = results.filter((r) => r.hardFail).length;
  const passRate = results.length > 0 ? passed / results.length : 0;
  const avgScore =
    results.length > 0
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
  for (const tag of Object.keys(byTag)) {
    byTag[tag].passRate = byTag[tag].passed / byTag[tag].total;
  }

  return {
    runId: crypto.randomUUID(),
    promptHash,
    model: opts.model,
    provider: opts.provider,
    timestamp: new Date().toISOString(),
    source: source.name,
    cases: results,
    summary: {
      total: results.length,
      passed,
      failed,
      hardFails,
      passRate,
      avgScore,
      byTag,
    },
  };
}
