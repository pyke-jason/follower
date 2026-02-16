import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { db, schema } from '../db/client.js';
import { sql, eq, and, like, lte, gte } from 'drizzle-orm';
import { createProvider, DEFAULT_LABEL_MODEL } from '../agent/providers.js';
import type { ModelProvider } from '../agent/providers.js';
import { runLabelAgent } from '../agent/label-agent.js';
import type { LabelAgentInput } from '../agent/label-agent.js';
import type { LabelToolDeps, NearbyMessage, TraderPosition } from '../agent/label-tools.js';
import { HistoricalDataStore } from '../agent/historical-data-store.js';
import { loadQuoteTape } from '../backtest/databento-tape.js';
import { reconstructPositions } from '../lib/position-reconstruction.js';
import type { LabelRow } from '../lib/position-reconstruction.js';
import { withRetry, oaiClassify, LLM_DEFAULTS } from '../lib/resilient.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('LabelRunner');

function safeJsonArray(raw: string | null): unknown[] {
  try { return JSON.parse(raw || '[]'); }
  catch { return []; }
}

// ─── Concurrency limiter ─────────────────────────────

function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++;
      queue.shift()!();
    }
  }
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject).finally(() => { active--; next(); }));
      next();
    });
}

// ─── CLI args ────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const COUNT = parseInt(flag('count', '20'), 10);
const LABEL_SET = flag('label-set', 'baseline');
const PROVIDER = flag('provider', DEFAULT_LABEL_MODEL.provider) as ModelProvider;
const MODEL = flag('model', PROVIDER === 'anthropic' ? DEFAULT_LABEL_MODEL.model : 'grok-4-1-fast-non-reasoning');
const CONCURRENCY = parseInt(flag('concurrency', '3'), 10);
const AUTO_REVIEWED = hasFlag('reviewed');
const LOAD_QUOTES = hasFlag('quotes');

// ─── DB query helpers ────────────────────────────────

async function getNearbyMessages(
  author: string,
  aroundTime: Date,
  windowMinutes: number,
): Promise<NearbyMessage[]> {
  const before = new Date(aroundTime.getTime() - windowMinutes * 60_000).toISOString();
  const after = new Date(aroundTime.getTime() + windowMinutes * 60_000).toISOString();

  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(
      eq(schema.messages.author, author),
      gte(schema.messages.timestamp, before),
      lte(schema.messages.timestamp, after),
    ))
    .orderBy(schema.messages.timestamp);

  return rows.map((m) => ({
    id: m.id,
    author: m.author,
    cleanText: m.cleanText,
    badges: (m.badges as string[]) ?? [],
    symbols: (m.symbols as string[]) ?? [],
    timestamp: m.timestamp,
    actionHint: m.actionHint,
    directionHint: m.directionHint,
  }));
}

async function searchTraderMessages(
  author: string,
  query: string,
  limit: number,
): Promise<NearbyMessage[]> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(
      eq(schema.messages.author, author),
      like(schema.messages.cleanText, `%${query}%`),
    ))
    .orderBy(schema.messages.timestamp)
    .limit(limit);

  return rows.map((m) => ({
    id: m.id,
    author: m.author,
    cleanText: m.cleanText,
    badges: (m.badges as string[]) ?? [],
    symbols: (m.symbols as string[]) ?? [],
    timestamp: m.timestamp,
    actionHint: m.actionHint,
    directionHint: m.directionHint,
  }));
}

async function getTraderPositionHistory(
  author: string,
  beforeTime: Date,
): Promise<TraderPosition[]> {
  const rows = await db
    .select({
      label: schema.messageLabels,
      message: schema.messages,
    })
    .from(schema.messageLabels)
    .innerJoin(schema.messages, eq(schema.messageLabels.messageId, schema.messages.id))
    .where(and(
      eq(schema.messages.author, author),
      eq(schema.messageLabels.isTrade, true),
      lte(schema.messages.timestamp, beforeTime.toISOString()),
    ))
    .orderBy(schema.messages.timestamp);

  const labels: LabelRow[] = rows.map(({ label, message }) => ({
    action: label.action,
    direction: label.direction,
    strategy: label.strategy,
    symbol: label.symbol,
    price: label.price,
    strikes: label.strikes,
    exitPercent: label.exitPercent ?? null,
    messageText: message.cleanText,
    messageTimestamp: message.timestamp,
  }));

  return reconstructPositions(labels);
}

// ─── Main ────────────────────────────────────────────

async function main() {
  const provider = await createProvider({ provider: PROVIDER, model: MODEL });
  log.info(`${provider.identity.provider}/${provider.identity.model} — label-set: ${LABEL_SET}, count: ${COUNT}, concurrency: ${CONCURRENCY}`);
  log.info(`auto-reviewed: ${AUTO_REVIEWED}, load-quotes: ${LOAD_QUOTES}`);

  // 1. Fetch unlabeled badged messages
  const unlabeled = await db.all<{
    id: string;
    author: string;
    clean_text: string;
    badges: string;
    symbols: string;
    raw_html: string;
    timestamp: string;
  }>(sql`
    SELECT m.id, m.author, m.clean_text, m.badges, m.symbols, m.raw_html, m.timestamp
    FROM messages m
    LEFT JOIN message_labels ml ON ml.message_id = m.id AND ml.label_set = ${LABEL_SET}
    WHERE json_array_length(m.badges) > 0
      AND ml.id IS NULL
    ORDER BY m.timestamp ASC
    LIMIT ${COUNT}
  `);

  if (unlabeled.length === 0) {
    log.info('No unlabeled badged messages found.');
    return;
  }

  log.info(`Found ${unlabeled.length} unlabeled messages.`);

  // 2. Optionally pre-load historical market data
  let historicalData: HistoricalDataStore | null = null;

  if (LOAD_QUOTES) {
    const apiKey = process.env.DATABENTO_API_KEY;
    if (!apiKey) {
      log.warn('DATABENTO_API_KEY not set — skipping quote loading');
    } else {
      // Extract unique symbols and dates
      const symbolDates = new Map<string, Date[]>();
      for (const msg of unlabeled) {
        const symbols = safeJsonArray(msg.symbols) as string[];
        const ts = new Date(msg.timestamp);
        for (const sym of symbols) {
          let dates = symbolDates.get(sym);
          if (!dates) { dates = []; symbolDates.set(sym, dates); }
          dates.push(ts);
        }
      }

      if (symbolDates.size > 0) {
        // Find date range
        const allDates = Array.from(symbolDates.values()).flat();
        const minDate = new Date(Math.min(...allDates.map((d) => d.getTime())));
        const maxDate = new Date(Math.max(...allDates.map((d) => d.getTime())));
        // Add a day buffer
        maxDate.setDate(maxDate.getDate() + 1);

        log.info(`Loading quotes for ${symbolDates.size} symbols...`);
        try {
          const ticks = await loadQuoteTape({
            apiKey,
            dataset: process.env.DATABENTO_DATASET ?? 'DBEQ.BASIC',
            symbols: Array.from(symbolDates.keys()),
            start: minDate,
            end: maxDate,
            symbolDates,
          });
          historicalData = new HistoricalDataStore(ticks);
          log.info(`Loaded ${ticks.length} ticks for ${historicalData.symbols.length} symbols`);
        } catch (err) {
          log.warn('Failed to load quotes:', err instanceof Error ? err.message : err);
        }
      }
    }
  }

  // 3. Process messages concurrently
  const limit = pLimit(CONCURRENCY);
  let labeled = 0;
  let errors = 0;

  const results = await Promise.allSettled(
    unlabeled.map((msg, idx) =>
      limit(async () => {
        const tag = `[${idx + 1}/${unlabeled.length}]`;

        const input: LabelAgentInput = {
          messageId: msg.id,
          cleanText: msg.clean_text,
          badges: safeJsonArray(msg.badges) as string[],
          symbols: safeJsonArray(msg.symbols) as string[],
          rawHtml: msg.raw_html,
          timestamp: msg.timestamp,
          author: msg.author,
        };

        const deps: LabelToolDeps = {
          messageTimestamp: new Date(msg.timestamp),
          messageAuthor: msg.author,
          getNearbyMessages,
          searchTraderMessages,
          getTraderPositionHistory,
          historicalData,
        };

        try {
          const result = await withRetry(
            async () => runLabelAgent(input, deps, provider),
            { ...LLM_DEFAULTS, classify: oaiClassify },
            `label:${msg.id.slice(0, 8)}`,
          );

          if (!result.label) {
            log.warn(`${tag} Agent did not submit a label for "${msg.clean_text.slice(0, 50)}..."`);
            errors++;
            return;
          }

          const label = result.label;
          const toolsUsed = result.steps
            .filter((s) => s.tool)
            .map((s) => s.tool)
            .join(', ');

          await db.insert(schema.messageLabels).values({
            messageId: msg.id,
            labelSet: LABEL_SET,
            isTrade: label.isTrade,
            action: label.action ?? null,
            direction: label.direction ?? null,
            strategy: label.strategy ?? null,
            symbol: label.symbol ?? null,
            price: label.price ?? null,
            strikes: label.strikes ?? null,
            quantity: label.quantity ?? null,
            expiry: label.expiry ?? null,
            exitPercent: label.exitPercent ?? null,
            source: 'agent',
            reviewed: AUTO_REVIEWED || label.confidence === 'high',
            notes: label.notes ?? null,
            modelProvider: provider.identity.provider,
            modelName: provider.identity.model,
          });

          labeled++;
          log.info(
            `${tag} ${label.isTrade ? 'TRADE' : 'SKIP '} ` +
            `${label.action ?? '-'}/${label.direction ?? '-'}/${label.strategy ?? '-'} ` +
            `${label.symbol ?? '-'} [${label.confidence ?? '?'}] ` +
            `tools: ${toolsUsed || 'none'}`
          );
        } catch (err) {
          log.error(`${tag} Error:`, err instanceof Error ? err.message : err);
          errors++;
        }
      })
    )
  );

  log.info(`Done! Labeled ${labeled}/${unlabeled.length} messages (${errors} errors) with label set "${LABEL_SET}".`);
}

main().catch((err) => {
  log.error('Fatal error:', err);
  process.exit(1);
});
