import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createAgent } from '@/agent/factory.js';
import type { ModelProvider } from '@/agent/result.js';
import { SignalSchema, type Signal } from '@/agent/schemas.js';
import type { DecisionOutcome } from '@/lib/enums.js';
import { STUB_BROKER } from '@/classify/stub-broker.js';
import { resolveOrchestrator } from '../orchestrator/index.js';
import type { SerializedParseResult } from '../orchestrator/types.js';
import { createFixtureChatHistoryProvider, evalInputToMessage } from './fixture-runner.js';
import type {
  EvalChatHistoryMessage,
  ReplayCorpus,
  ReplayCorpusMessage,
  ReplayDiffResult,
  ReplayMismatch,
  ReplayResult,
  ReplayRunResult,
} from './types.js';

export type CohortName = 'commentary-skip' | 'simple-structured-exec' | 'exit-loop';

const FIELDS = [
  'action',
  'symbol',
  'strategy',
  'direction',
  'strikes',
  'expiry',
  'statedPrice',
  'quantity',
  'exitPercent',
  'targetStrategy',
] as const;
type Field = typeof FIELDS[number];

export async function exportReplayCorpus(params: {
  databaseUrl?: string;
  corpus: CohortName;
  model?: string;
  limit?: number;
}): Promise<ReplayCorpus> {
  const databaseUrl = resolveDatabaseUrl(params.databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, allowExitOnIdle: true });
  try {
    const { query, values } = cohortSql(params.corpus, params.model, params.limit ?? 250);
    const { rows } = await pool.query<RawCorpusRow>(query, values);

    const messages: ReplayCorpusMessage[] = await Promise.all(rows.map(async (row) => ({
      messageId: row.messageId,
      author: row.author,
      timestamp: row.timestamp,
      rawHtml: row.rawHtml,
      cleanText: row.cleanText,
      badges: parseJson<string[]>(row.badges, []),
      symbols: parseJson<string[]>(row.symbols, []),
      history: await loadHistory(pool, row.timestamp),
      oracle: {
        outcome: normalizeOutcome(row.decision),
        classifierSignals: parseSignals(row.signals),
        route: row.route,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadInputTokens: row.cacheReadInputTokens,
        cacheCreationInputTokens: row.cacheCreationInputTokens,
        costUsd: row.costUsd,
        turns: row.turns,
      },
    })));

    return {
      name: params.corpus,
      exportedAt: new Date().toISOString(),
      query,
      messages,
    };
  } finally {
    await pool.end();
  }
}

export async function runReplay(params: {
  corpus: ReplayCorpus;
  provider: ModelProvider;
  model: string;
  concurrency?: number;
  logProgress?: boolean;
}): Promise<ReplayRunResult> {
  const agent = await createAgent({ provider: params.provider, model: params.model });
  const concurrency = Math.max(1, params.concurrency ?? 8);
  const queue = [...params.corpus.messages];
  const results: ReplayResult[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const result = await replayOne(item, agent);
      results.push(result);
      if (params.logProgress) {
        const label = result.outcome === 'ERROR' ? 'ERR ' : result.route.toUpperCase().padEnd(5).slice(0, 5);
        console.log(`  ${label} ${item.messageId} ${item.cleanText.slice(0, 80)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()));
  return buildReplayRunResult({
    provider: params.provider,
    model: params.model,
    corpusName: params.corpus.name,
    results: results.sort((a, b) => a.messageId.localeCompare(b.messageId)),
  });
}

export function diffReplayRuns(
  baseline: ReplayRunResult,
  candidate: ReplayRunResult,
): ReplayDiffResult {
  const baselineById = new Map(baseline.results.map(r => [r.messageId, r]));
  const candidateById = new Map(candidate.results.map(r => [r.messageId, r]));
  const regressions: ReplayMismatch[] = [];

  for (const [id, actual] of candidateById) {
    const expected = baselineById.get(id);
    if (!expected) continue;
    regressions.push(...compareReplayResult(expected, actual));
  }

  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    timestamp: new Date().toISOString(),
    totalCompared: Array.from(candidateById.keys()).filter(id => baselineById.has(id)).length,
    regressions,
    routeDeltas: deltaCounts(baseline.summary.byRoute, candidate.summary.byRoute),
    costDeltaUsd: candidate.summary.totalCostUsd - baseline.summary.totalCostUsd,
    llmCallDelta: (candidate.summary.byRoute.llm ?? 0) - (baseline.summary.byRoute.llm ?? 0),
  };
}

export function printReplayReport(run: ReplayRunResult): void {
  console.log(`\n=== Intent Replay Run ===`);
  console.log(`Corpus:   ${run.corpusName}`);
  console.log(`Model:    ${run.model} (${run.provider})`);
  console.log(`Messages: ${run.summary.total}`);
  console.log(`Routes:   ${formatCounts(run.summary.byRoute)}`);
  console.log(`Outcome:  ${formatCounts(run.summary.byOutcome)}`);
  console.log(`Cost:     $${run.summary.totalCostUsd.toFixed(4)} input=${run.summary.totalInputTokens} cacheRead=${run.summary.totalCacheReadInputTokens}`);
  if (Object.keys(run.summary.byRuleId).length > 0) {
    console.log(`Rules:    ${formatCounts(run.summary.byRuleId)}`);
  }
}

export function printReplayDiff(diff: ReplayDiffResult): void {
  console.log(`\n=== Intent Replay Diff ===`);
  console.log(`Compared:       ${diff.totalCompared}`);
  console.log(`Regressions:    ${diff.regressions.length}`);
  console.log(`LLM call delta: ${diff.llmCallDelta}`);
  console.log(`Cost delta:     $${diff.costDeltaUsd.toFixed(4)}`);
  console.log(`Route deltas:   ${formatCounts(diff.routeDeltas)}`);
  for (const mismatch of diff.regressions.slice(0, 25)) {
    console.log(`  ${mismatch.messageId} ${mismatch.field}: expected=${JSON.stringify(mismatch.expected)} actual=${JSON.stringify(mismatch.actual)}`);
  }
}

async function replayOne(
  item: ReplayCorpusMessage,
  agent: Awaited<ReturnType<typeof createAgent>>,
): Promise<ReplayResult> {
  const message = evalInputToMessage(item.messageId, item.rawHtml, {
    author: item.author,
    timestamp: item.timestamp,
  });
  const chatHistory = createFixtureChatHistoryProvider(item.history, {
    defaultAuthor: item.author,
    defaultTimestamp: item.timestamp,
  });

  try {
    const result = await resolveOrchestrator(message, {
      getPositions: async () => [],
      agent,
      broker: STUB_BROKER,
      emitter: { emit: async () => {} },
      chatHistory,
    });

    const parse = result.parseResult as SerializedParseResult | undefined;
    const route = parse?.isHardSkip
      ? 'hard-skip'
      : result.usage && result.usage.inputTokens > 0
        ? 'llm'
        : 'deterministic';

    return {
      messageId: item.messageId,
      outcome: result.outcome,
      route,
      ruleId: parse?.ruleId ?? null,
      routeReason: parse?.routeReason ?? null,
      classifierSignals: result.classifierSignals ?? [],
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: result.usage?.cacheCreationInputTokens ?? 0,
      costUsd: result.usage?.costUsd ?? 0,
    };
  } catch (err) {
    return {
      messageId: item.messageId,
      outcome: 'ERROR',
      route: 'error',
      ruleId: null,
      routeReason: null,
      classifierSignals: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildReplayRunResult(params: {
  provider: string;
  model: string;
  corpusName: string;
  results: ReplayResult[];
}): ReplayRunResult {
  const byOutcome: Record<string, number> = {};
  const byRoute: Record<string, number> = {};
  const byRuleId: Record<string, number> = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let totalCostUsd = 0;

  for (const result of params.results) {
    byOutcome[result.outcome] = (byOutcome[result.outcome] ?? 0) + 1;
    byRoute[result.route] = (byRoute[result.route] ?? 0) + 1;
    if (result.ruleId) byRuleId[result.ruleId] = (byRuleId[result.ruleId] ?? 0) + 1;
    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
    totalCacheReadInputTokens += result.cacheReadInputTokens;
    totalCacheCreationInputTokens += result.cacheCreationInputTokens;
    totalCostUsd += result.costUsd;
  }

  return {
    runId: randomUUID(),
    provider: params.provider,
    model: params.model,
    timestamp: new Date().toISOString(),
    corpusName: params.corpusName,
    results: params.results,
    summary: {
      total: params.results.length,
      byOutcome,
      byRoute,
      byRuleId,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadInputTokens,
      totalCacheCreationInputTokens,
      totalCostUsd,
    },
  };
}

function resolveDatabaseUrl(override: string | undefined): string {
  const databaseUrl = override
    ?? process.env.POSTGRES_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? 'postgres://jason@127.0.0.1:5432/trade_follower';
  if (databaseUrl.startsWith('file:')) {
    throw new Error('Intent replay export requires POSTGRES_DATABASE_URL, not file-backed DATABASE_URL');
  }
  return databaseUrl;
}

function cohortSql(corpus: CohortName, model: string | undefined, limit: number): { query: string; values: unknown[] } {
  const values: unknown[] = [];
  const modelParam = model != null ? `$${values.push(model)}` : null;
  const limitParam = `$${values.push(limit)}`;
  const modelWhere = modelParam ? `and mi.model = ${modelParam}` : '';
  const base = `
    select
      m.id as "messageId",
      m.author as author,
      m.timestamp as timestamp,
      m.raw_html as "rawHtml",
      m.clean_text as "cleanText",
      m.badges as badges,
      m.symbols as symbols,
      mi.route as route,
      mi.decision as decision,
      mi.signals as signals,
      mi.input_tokens as "inputTokens",
      mi.output_tokens as "outputTokens",
      mi.cache_read_input_tokens as "cacheReadInputTokens",
      mi.cache_creation_input_tokens as "cacheCreationInputTokens",
      mi.cost_usd as "costUsd",
      mi.turns as turns
    from message_intents mi
    inner join messages m on m.id = mi.message_id
    where mi.created_at = (
      select max(mi2.created_at)
      from message_intents mi2
      where mi2.message_id = mi.message_id
      ${modelParam ? `and mi2.model = ${modelParam}` : ''}
    )
    ${modelWhere}
  `;

  const filters = {
    'commentary-skip': `
      and mi.route = 'llm'
      and mi.decision = 'SKIP'
      and (
        lower(m.clean_text) like '%nothing actionable%'
        or lower(m.clean_text) like 'offering %'
        or lower(m.clean_text) like '%setting an alert%'
        or lower(m.clean_text) like '%watching %'
        or lower(m.clean_text) like '%would %'
        or lower(m.clean_text) like '%looking to%'
        or lower(m.clean_text) like '%prepared to%'
        or lower(m.clean_text) like '%can be had for%'
      )
    `,
    'simple-structured-exec': `
      and mi.route = 'llm'
      and mi.decision = 'EXECUTE'
      and (
        lower(m.clean_text) like 'added to %'
        or lower(m.clean_text) like 'long % $%'
        or lower(m.clean_text) like 'short % $%'
      )
    `,
    'exit-loop': `
      and mi.route = 'llm'
      and mi.decision in ('EXECUTE', 'MANUAL_REVIEW')
      and (
        coalesce(mi.turns, 0) > 1
        or lower(coalesce(mi.steps::text, '')) like '%get_recent_chat%'
        or lower(coalesce(mi.steps::text, '')) like '%verification feedback%'
      )
    `,
  } satisfies Record<CohortName, string>;

  return { query: `${base} ${filters[corpus]} order by m.timestamp asc, m.id asc limit ${limitParam}`, values };
}

async function loadHistory(pool: pg.Pool, beforeTimestamp: string, limit = 50): Promise<EvalChatHistoryMessage[]> {
  const { rows } = await pool.query<{ author: string; timestamp: string; rawHtml: string }>(`
    select author, timestamp, raw_html as "rawHtml"
    from messages
    where timestamp < $1
    order by timestamp desc
    limit $2
  `, [beforeTimestamp, limit]);

  return rows.reverse().map((row) => ({
    author: row.author,
    timestamp: row.timestamp,
    rawHtml: row.rawHtml,
  }));
}

function compareReplayResult(expected: ReplayResult, actual: ReplayResult): ReplayMismatch[] {
  const mismatches: ReplayMismatch[] = [];
  if (expected.outcome !== actual.outcome) {
    mismatches.push({ messageId: actual.messageId, field: 'outcome', expected: expected.outcome, actual: actual.outcome });
  }
  if (expected.classifierSignals.length !== actual.classifierSignals.length) {
    mismatches.push({
      messageId: actual.messageId,
      field: 'classifierSignals.length',
      expected: expected.classifierSignals.length,
      actual: actual.classifierSignals.length,
    });
    return mismatches;
  }

  for (let i = 0; i < expected.classifierSignals.length; i++) {
    const exp = expected.classifierSignals[i];
    const act = actual.classifierSignals[i];
    for (const field of FIELDS) {
      const ev = (exp as Record<string, unknown>)[field];
      const av = (act as Record<string, unknown>)[field];
      if (ev == null && av == null) continue;
      if (!fieldEq(field, ev, av, exp.action ?? act.action)) {
        mismatches.push({
          messageId: actual.messageId,
          field: `classifierSignals[${i}].${field}`,
          expected: ev,
          actual: av,
        });
      }
    }
  }

  return mismatches;
}

function fieldEq(field: Field, expected: unknown, actual: unknown, action?: unknown): boolean {
  if (field === 'strikes') return strikesEq(expected as number[] | null, actual as number[] | null);
  if (field === 'expiry') return normExpiry(expected as string | null) === normExpiry(actual as string | null);
  if (field === 'statedPrice') return numEq(expected as number | null, actual as number | null);
  if (field === 'quantity') return numEq(expected as number | null, actual as number | null, 0);
  if (field === 'exitPercent') {
    const isClose = norm(action) === 'CLOSE';
    const a = expected == null ? 1 : Number(expected);
    const b = actual == null ? 1 : Number(actual);
    if (isClose && Math.abs(a - 1) < 0.01 && Math.abs(b - 1) < 0.01) return true;
    return numEq(expected as number | null, actual as number | null);
  }
  if (field === 'action') {
    const a = norm(expected);
    const b = norm(actual);
    if ((a === 'OPEN' && b === 'ADD') || (a === 'ADD' && b === 'OPEN')) return true;
    return a === b;
  }
  return norm(expected) === norm(actual);
}

function strikesEq(a: number[] | null | undefined, b: number[] | null | undefined): boolean {
  const aa = a ?? null;
  const bb = b ?? null;
  if (aa == null || bb == null) return aa == null && bb == null;
  if (aa.length !== bb.length) return false;
  return aa.every((x, i) => Math.abs(x - bb[i]) <= 0.01);
}

function numEq(a: number | null | undefined, b: number | null | undefined, tol = 0.01): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= tol;
}

function norm(v: unknown): string | null {
  if (v == null || v === '') return null;
  return String(v).trim().toUpperCase();
}

function normExpiry(v: string | null | undefined): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const iso = /^\d{4}-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return `${parseInt(iso[1], 10)}/${parseInt(iso[2], 10)}`;
  const us = /^(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?$/.exec(s);
  if (us) return `${parseInt(us[1], 10)}/${parseInt(us[2], 10)}`;
  const lower = s.toLowerCase();
  const months: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
    october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  const dm = /^(\d{1,2})\s+([a-z]+)$/.exec(lower);
  const md = /^([a-z]+)\s*(?:\(\s*(\d{1,2})\s*\)|\s+(\d{1,2}))$/.exec(lower);
  if (dm && months[dm[2]]) return `${months[dm[2]]}/${parseInt(dm[1], 10)}`;
  if (md && months[md[1]]) return `${months[md[1]]}/${parseInt(md[2] ?? md[3], 10)}`;
  if (/^tomorrow'?s?$/i.test(s)) return 'tomorrow';
  if (/^expiring\s+tomorrow$/i.test(s)) return 'tomorrow';
  if (/^expiring\s+today$/i.test(s)) return 'today';
  return lower;
}

function deltaCounts(base: Record<string, number>, current: Record<string, number>): Record<string, number> {
  const keys = new Set([...Object.keys(base), ...Object.keys(current)]);
  return Object.fromEntries(Array.from(keys).sort().map(key => [key, (current[key] ?? 0) - (base[key] ?? 0)]));
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseSignals(raw: unknown): Signal[] {
  const value = parseJson<unknown>(raw, null);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = SignalSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function normalizeOutcome(raw: string): DecisionOutcome | 'ERROR' {
  if (raw === 'EXECUTE' || raw === 'SKIP' || raw === 'MANUAL_REVIEW') return raw;
  return 'ERROR';
}

type RawCorpusRow = {
  messageId: string;
  author: string;
  timestamp: string;
  rawHtml: string;
  cleanText: string;
  badges: unknown;
  symbols: unknown;
  route: string | null;
  decision: string;
  signals: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  costUsd: number | null;
  turns: number | null;
};
