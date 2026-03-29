import { Hono } from 'hono';
import { db, schema } from '@/db/client.js';
import { eq, and, desc, sql, count, asc, gte, lte } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

const app = new Hono();

// ── GET /eval/review — Discrepancy review list for keyboard-driven UI ─────

app.get('/eval/review', async (c) => {
  const category = c.req.query('category');
  const reviewed = c.req.query('reviewed'); // 'true' | 'false' | undefined (all)
  const author = c.req.query('author');
  const startDate = c.req.query('start');
  const endDate = c.req.query('end');
  const sortBy = c.req.query('sort') ?? 'timestamp'; // timestamp | category | author | verdict
  const sortDir = c.req.query('dir') ?? 'asc'; // asc | desc
  const limit = parseInt(c.req.query('limit') ?? '500', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const conditions: SQL[] = [];
  if (category) conditions.push(eq(schema.discrepancyReviews.category, category as never));
  if (reviewed === 'true') conditions.push(eq(schema.discrepancyReviews.reviewed, true));
  if (reviewed === 'false') conditions.push(eq(schema.discrepancyReviews.reviewed, false));
  if (author) conditions.push(eq(schema.discrepancyReviews.author, author));
  if (startDate) conditions.push(gte(schema.discrepancyReviews.timestamp, startDate));
  if (endDate) conditions.push(lte(schema.discrepancyReviews.timestamp, endDate));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortCol = {
    timestamp: schema.discrepancyReviews.timestamp,
    category: schema.discrepancyReviews.category,
    author: schema.discrepancyReviews.author,
    verdict: schema.discrepancyReviews.agentVerdict,
  }[sortBy] ?? schema.discrepancyReviews.timestamp;
  const orderFn = sortDir === 'desc' ? desc : asc;

  const rows = await db.select().from(schema.discrepancyReviews)
    .where(where)
    .orderBy(orderFn(sortCol))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db.select({ total: count() })
    .from(schema.discrepancyReviews)
    .where(where);

  // Stats
  const [stats] = await db.select({
    total: count(),
    reviewed: sql<number>`SUM(CASE WHEN reviewed = 1 THEN 1 ELSE 0 END)`,
    parserRight: sql<number>`SUM(CASE WHEN verdict = 'parser_right' AND reviewed = 1 THEN 1 ELSE 0 END)`,
    labelRight: sql<number>`SUM(CASE WHEN verdict = 'label_right' AND reviewed = 1 THEN 1 ELSE 0 END)`,
    bothWrong: sql<number>`SUM(CASE WHEN verdict = 'both_wrong' AND reviewed = 1 THEN 1 ELSE 0 END)`,
    skipped: sql<number>`SUM(CASE WHEN verdict = 'skip' AND reviewed = 1 THEN 1 ELSE 0 END)`,
  }).from(schema.discrepancyReviews);

  return c.json({
    rows,
    total,
    offset,
    limit,
    stats: {
      total: stats.total,
      reviewed: Number(stats.reviewed ?? 0),
      parserRight: Number(stats.parserRight ?? 0),
      labelRight: Number(stats.labelRight ?? 0),
      bothWrong: Number(stats.bothWrong ?? 0),
      skipped: Number(stats.skipped ?? 0),
    },
  });
});

// ── GET /eval/review/:messageId/context — Chat context for a discrepancy ──

app.get('/eval/review/:messageId/context', async (c) => {
  const messageId = c.req.param('messageId');

  // Get the target message
  const [msg] = await db.select().from(schema.messages)
    .where(eq(schema.messages.id, messageId));
  if (!msg) return c.json({ error: 'Message not found' }, 404);

  // Get surrounding messages from same author within ±4 hours
  const surrounding = await db.select({
    id: schema.messages.id,
    author: schema.messages.author,
    cleanText: schema.messages.cleanText,
    badges: schema.messages.badges,
    symbols: schema.messages.symbols,
    timestamp: schema.messages.timestamp,
  }).from(schema.messages)
    .where(and(
      eq(schema.messages.author, msg.author),
      gte(schema.messages.timestamp, new Date(new Date(msg.timestamp).getTime() - 4 * 60 * 60 * 1000).toISOString()),
      lte(schema.messages.timestamp, new Date(new Date(msg.timestamp).getTime() + 1 * 60 * 60 * 1000).toISOString()),
    ))
    .orderBy(asc(schema.messages.timestamp))
    .limit(30);

  return c.json({
    target: messageId,
    author: msg.author,
    messages: surrounding,
  });
});

// ── GET /eval — Parser vs ground-truth evaluation dashboard ───────────────

type EvalDiscrepancy = {
  messageId: string;
  author: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
  timestamp: string;
  category: string;
  parserAction: string | null;
  parserStrategy: string | null;
  parserDirection: string | null;
  parserSkipReason: string | null;
  parserFlags: string[];
  labelAction: string | null;
  labelStrategy: string | null;
  labelDirection: string | null;
  labelNotes: string | null;
  verdict: string | null;
  verdictReason: string | null;
};

type EvalSummary = {
  totalMessages: number;
  totalLabeled: number;
  totalWithSignals: number;
  totalSkipLabels: number;
  confusion: {
    parserSkip_labelSkip: number;
    parserSkip_labelExecute: number;
    parserExecute_labelSkip: number;
    parserExecute_labelExecute: number;
    parserNull_labelSkip: number;
    parserNull_labelExecute: number;
  };
  metrics: {
    precision: number;
    recall: number;
    f1: number;
    falseNegatives: number;
    falsePositives: number;
  };
  actionMismatches: Record<string, number>;
  strategyMismatches: Record<string, number>;
  directionMismatches: Record<string, number>;
  discrepancies: EvalDiscrepancy[];
  verdictSummary: {
    total: number;
    parserRight: number;
    labelRight: number;
    bothWrong: number;
    unreviewed: number;
  };
};

app.get('/eval', async (c) => {
  const category = c.req.query('category'); // false_positive, false_negative, action_mismatch, strategy_mismatch, direction_mismatch
  const limit = parseInt(c.req.query('limit') ?? '200', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // Load comparison results from pre-computed file
  const { readFileSync, existsSync } = await import('fs');
  const compPath = 'scratchpad/parser-comparison-results.json';
  if (!existsSync(compPath)) {
    return c.json({ error: 'Run scratchpad/compare-parser-vs-labels.ts first' }, 404);
  }

  const compData = JSON.parse(readFileSync(compPath, 'utf-8'));

  // Load discrepancy batches + verdicts
  const discBatchDir = 'scratchpad/discrepancy-batches';
  const { readdirSync } = await import('fs');
  let allDiscrepancies: Array<Record<string, unknown>> = [];
  const verdictMap = new Map<string, { verdict: string; reason: string }>();

  if (existsSync(discBatchDir)) {
    const files = readdirSync(discBatchDir);

    // Load all batch files
    for (const f of files.filter(f => f.startsWith('batch-') && f.endsWith('.json'))) {
      try {
        const batch = JSON.parse(readFileSync(`${discBatchDir}/${f}`, 'utf-8'));
        allDiscrepancies.push(...batch);
      } catch { /* skip malformed */ }
    }

    // Load all verdict files
    for (const f of files.filter(f => f.startsWith('verdict-') && f.endsWith('.json'))) {
      try {
        const verdicts = JSON.parse(readFileSync(`${discBatchDir}/${f}`, 'utf-8'));
        for (const v of verdicts) {
          if (v.id && v.verdict) {
            verdictMap.set(v.id, { verdict: v.verdict, reason: v.reason ?? '' });
          }
        }
      } catch { /* skip malformed */ }
    }
  }

  // Build verdict summary
  let parserRight = 0, labelRight = 0, bothWrong = 0, unreviewed = 0;
  for (const d of allDiscrepancies) {
    const v = verdictMap.get(d.id as string);
    if (!v) { unreviewed++; continue; }
    if (v.verdict === 'parser_right') parserRight++;
    else if (v.verdict === 'label_right') labelRight++;
    else if (v.verdict === 'both_wrong') bothWrong++;
    else unreviewed++;
  }

  // Filter and paginate discrepancies
  let filtered = allDiscrepancies;
  if (category) {
    filtered = filtered.filter(d => d.category === category);
  }
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  // Map to response type with verdicts
  const discrepancies: EvalDiscrepancy[] = page.map(d => {
    const v = verdictMap.get(d.id as string);
    return {
      messageId: d.messageId as string,
      author: d.author as string,
      cleanText: d.cleanText as string,
      badges: d.badges as string[],
      symbols: d.symbols as string[],
      timestamp: d.timestamp as string,
      category: d.category as string,
      parserAction: d.parserAction as string | null,
      parserStrategy: d.parserStrategy as string | null,
      parserDirection: d.parserDirection as string | null,
      parserSkipReason: d.parserSkipReason as string | null,
      parserFlags: d.parserFlags as string[],
      labelAction: d.labelAction as string | null,
      labelStrategy: d.labelStrategy as string | null,
      labelDirection: d.labelDirection as string | null,
      labelNotes: d.labelNotes as string | null,
      verdict: v?.verdict ?? null,
      verdictReason: v?.reason ?? null,
    };
  });

  // Summary from label counts
  const labelStats = await db.select({
    total: count(),
    withSignals: sql<number>`SUM(CASE WHEN signals != '[]' THEN 1 ELSE 0 END)`,
    skipLabels: sql<number>`SUM(CASE WHEN notes LIKE 'skip:%' THEN 1 ELSE 0 END)`,
  }).from(schema.messageLabels);

  const msgCount = await db.select({ total: count() }).from(schema.messages);

  const summary: EvalSummary = {
    totalMessages: msgCount[0].total,
    totalLabeled: labelStats[0].total,
    totalWithSignals: Number(labelStats[0].withSignals ?? 0),
    totalSkipLabels: Number(labelStats[0].skipLabels ?? 0),
    confusion: compData.confusion,
    metrics: compData.metrics,
    actionMismatches: compData.confusion.actionMismatchDetails ?? {},
    strategyMismatches: compData.confusion.strategyMismatchDetails ?? {},
    directionMismatches: compData.confusion.directionMismatchDetails ?? {},
    discrepancies,
    verdictSummary: {
      total: allDiscrepancies.length,
      parserRight,
      labelRight,
      bothWrong,
      unreviewed,
    },
  };

  return c.json({ ...summary, filteredTotal: total, offset, limit });
});

export default app;
