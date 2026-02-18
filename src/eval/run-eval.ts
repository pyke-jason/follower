import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { db, schema } from '../db/client.js';
import { eq, and, desc } from 'drizzle-orm';
import type { Signal } from '../agent/schemas.js';

// ─── Types ───────────────────────────────────────────

type FieldResult = { correct: number; total: number };
type FieldName = 'isTrade' | 'action' | 'direction' | 'strategy' | 'symbol' | 'price' | 'strikes';

type Failure = {
  cleanText: string;
  field: string;
  expected: string;
  got: string;
};

// ─── Comparison helpers ──────────────────────────────

function normalizeNull(v: unknown): string | null {
  if (v === undefined || v === null || v === '' || v === 'null') return null;
  return String(v);
}

function priceMatch(expected: string | null, got: string | null): boolean {
  if (expected === null && got === null) return true;
  if (expected === null || got === null) return false;
  const e = parseFloat(expected);
  const g = parseFloat(got);
  if (isNaN(e) || isNaN(g)) return expected === got;
  return Math.abs(e - g) <= 0.05;
}

function strikesMatch(expected: number[] | null, got: number[] | undefined): boolean {
  const e = expected ?? [];
  const g = got ?? [];
  if (e.length !== g.length) return false;
  const eSorted = [...e].sort((a, b) => a - b);
  const gSorted = [...g].sort((a, b) => a - b);
  return eSorted.every((v, i) => Math.abs(v - gSorted[i]) <= 0.01);
}

// ─── CLI args ────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const MODEL_FILTER = flag('model', '');
const VERSION_FILTER = flag('version', '');

// ─── Main ────────────────────────────────────────────

async function main() {
  // 1. Load all reviewed labels
  const labelRows = await db
    .select({
      label: schema.messageLabels,
      message: schema.messages,
    })
    .from(schema.messageLabels)
    .innerJoin(schema.messages, eq(schema.messageLabels.messageId, schema.messages.id))
    .where(eq(schema.messageLabels.reviewed, true));

  if (labelRows.length === 0) {
    console.log('No reviewed labels found. Approve some labels in the chat UI first.');
    return;
  }

  // 2. Load latest intent for each labeled message
  const messageIds = labelRows.map((r) => r.label.messageId);
  const allIntents = await db
    .select()
    .from(schema.messageIntents)
    .orderBy(desc(schema.messageIntents.version));

  // Build map: messageId → latest intent (optionally filtered by model/version)
  const intentMap = new Map<string, typeof schema.messageIntents.$inferSelect>();
  for (const intent of allIntents) {
    if (!messageIds.includes(intent.messageId)) continue;
    if (MODEL_FILTER && intent.model !== MODEL_FILTER) continue;
    if (VERSION_FILTER && intent.version !== parseInt(VERSION_FILTER)) continue;

    const existing = intentMap.get(intent.messageId);
    if (!existing || intent.version > existing.version) {
      intentMap.set(intent.messageId, intent);
    }
  }

  // Filter to labels that have a matching intent
  const matched = labelRows.filter((r) => intentMap.has(r.label.messageId));

  if (matched.length === 0) {
    console.log('No intents found for the reviewed labels. Run intent extraction first.');
    return;
  }

  // Determine model/version info from first match
  const firstIntent = intentMap.get(matched[0].label.messageId)!;
  const modelInfo = `${firstIntent.model} v${firstIntent.version}`;
  console.log(`\nEval Report (${modelInfo}, ${matched.length} labeled messages with intents)`);
  console.log('─'.repeat(60));

  const fields: Record<FieldName, FieldResult> = {
    isTrade:   { correct: 0, total: 0 },
    action:    { correct: 0, total: 0 },
    direction: { correct: 0, total: 0 },
    strategy:  { correct: 0, total: 0 },
    symbol:    { correct: 0, total: 0 },
    price:     { correct: 0, total: 0 },
    strikes:   { correct: 0, total: 0 },
  };

  let allCorrect = 0;
  const failures: Failure[] = [];

  for (const { label, message } of matched) {
    const intent = intentMap.get(label.messageId)!;
    const signals = (intent.signals ?? []) as Signal[];
    const signal = signals[0];
    let rowAllCorrect = true;

    // ── isTrade (EXECUTE vs SKIP classification) ──
    fields.isTrade.total++;
    const intentIsTrade = intent.decision === 'EXECUTE' && signals.length > 0;
    const labelIsTrade = label.isTrade === true;
    if (intentIsTrade === labelIsTrade) {
      fields.isTrade.correct++;
    } else {
      rowAllCorrect = false;
      failures.push({
        cleanText: message.cleanText.slice(0, 60),
        field: 'isTrade',
        expected: String(labelIsTrade),
        got: String(intentIsTrade),
      });
    }

    // Only compare fields when BOTH say it's a trade
    if (intentIsTrade && labelIsTrade && signal) {
      // Action
      fields.action.total++;
      if (normalizeNull(signal.action) === normalizeNull(label.action)) {
        fields.action.correct++;
      } else {
        rowAllCorrect = false;
        failures.push({
          cleanText: message.cleanText.slice(0, 60),
          field: 'action',
          expected: normalizeNull(label.action) ?? 'null',
          got: normalizeNull(signal.action) ?? 'null',
        });
      }

      // Direction
      fields.direction.total++;
      if (normalizeNull(signal.direction) === normalizeNull(label.direction)) {
        fields.direction.correct++;
      } else {
        rowAllCorrect = false;
        failures.push({
          cleanText: message.cleanText.slice(0, 60),
          field: 'direction',
          expected: normalizeNull(label.direction) ?? 'null',
          got: normalizeNull(signal.direction) ?? 'null',
        });
      }

      // Strategy
      fields.strategy.total++;
      if (normalizeNull(signal.strategy) === normalizeNull(label.strategy)) {
        fields.strategy.correct++;
      } else {
        rowAllCorrect = false;
        failures.push({
          cleanText: message.cleanText.slice(0, 60),
          field: 'strategy',
          expected: normalizeNull(label.strategy) ?? 'null',
          got: normalizeNull(signal.strategy) ?? 'null',
        });
      }

      // Symbol
      fields.symbol.total++;
      const intentSymbol = normalizeNull(signal.symbol)?.toUpperCase() ?? null;
      const labelSymbol = normalizeNull(label.symbol)?.toUpperCase() ?? null;
      if (intentSymbol === labelSymbol) {
        fields.symbol.correct++;
      } else {
        rowAllCorrect = false;
        failures.push({
          cleanText: message.cleanText.slice(0, 60),
          field: 'symbol',
          expected: labelSymbol ?? 'null',
          got: intentSymbol ?? 'null',
        });
      }

      // Price
      if (label.price != null) {
        fields.price.total++;
        const intentPrice = normalizeNull(signal.limitPrice);
        const labelPrice = normalizeNull(label.price);
        if (priceMatch(labelPrice, intentPrice)) {
          fields.price.correct++;
        } else {
          rowAllCorrect = false;
          failures.push({
            cleanText: message.cleanText.slice(0, 60),
            field: 'price',
            expected: labelPrice ?? 'null',
            got: intentPrice ?? 'null',
          });
        }
      }

      // Strikes
      if (label.strikes && label.strikes.length > 0) {
        fields.strikes.total++;
        const intentStrikes = signal.legs?.map((l) => parseFloat(l.strike));
        if (strikesMatch(label.strikes, intentStrikes)) {
          fields.strikes.correct++;
        } else {
          rowAllCorrect = false;
          failures.push({
            cleanText: message.cleanText.slice(0, 60),
            field: 'strikes',
            expected: JSON.stringify(label.strikes),
            got: JSON.stringify(intentStrikes ?? []),
          });
        }
      }
    }

    if (rowAllCorrect) allCorrect++;
  }

  // Print summary
  const overallPct = ((allCorrect / matched.length) * 100).toFixed(1);
  console.log(`Overall accuracy:    ${overallPct}%  (${allCorrect}/${matched.length} all fields match)`);
  console.log('─'.repeat(60));

  function accuracy(f: FieldResult): number | null {
    return f.total > 0 ? f.correct / f.total : null;
  }

  console.log('\nIntent Extraction vs Labels:');
  console.log(`${'  Field'.padEnd(16)} ${'Correct'.padStart(8)} ${'Total'.padStart(8)} ${'Accuracy'.padStart(10)}`);
  for (const name of Object.keys(fields) as FieldName[]) {
    const result = fields[name];
    const pct = result.total > 0 ? ((result.correct / result.total) * 100).toFixed(1) : 'N/A';
    console.log(
      `${'  ' + name.padEnd(14)} ${String(result.correct).padStart(8)} ${String(result.total).padStart(8)} ${(pct + '%').padStart(10)}`
    );
  }

  // Persist to eval_runs table
  const runId = crypto.randomUUID();
  await db.insert(schema.evalRuns).values({
    id: runId,
    ranAt: new Date().toISOString(),
    intentModel: firstIntent.model,
    intentVersion: firstIntent.version,
    totalLabels: matched.length,
    isTradeAccuracy: accuracy(fields.isTrade),
    actionAccuracy: accuracy(fields.action),
    directionAccuracy: accuracy(fields.direction),
    strategyAccuracy: accuracy(fields.strategy),
    symbolAccuracy: accuracy(fields.symbol),
    priceAccuracy: accuracy(fields.price),
    strikesAccuracy: accuracy(fields.strikes),
    overallAccuracy: allCorrect / matched.length,
    totalMislabelings: failures.length,
    failuresJson: failures.slice(0, 100),
  });

  console.log(`\nResults persisted to eval_runs (id: ${runId.slice(0, 8)}...)`);

  // Print failures
  if (failures.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log(`Failures (showing first 20 of ${failures.length}):\n`);
    for (const f of failures.slice(0, 20)) {
      console.log(`  "${f.cleanText}..."`);
      console.log(`    ${f.field}: expected=${f.expected}, got=${f.got}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
