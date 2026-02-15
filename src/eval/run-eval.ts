import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { db, schema } from '../db/client.js';
import { eq, and } from 'drizzle-orm';
import { classifyMessage } from '../parsing/classify.js';

// ─── Types ───────────────────────────────────────────

type FieldResult = { correct: number; total: number };
type FieldName = 'action' | 'direction' | 'strategy' | 'price' | 'strikes' | 'quantity' | 'expiry' | 'exitPercent';

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
  return Math.abs(e - g) <= 0.01;
}

function strikesMatch(expected: number[] | null, got: number[] | undefined): boolean {
  const e = expected ?? [];
  const g = got ?? [];
  if (e.length !== g.length) return false;
  const eSorted = [...e].sort((a, b) => a - b);
  const gSorted = [...g].sort((a, b) => a - b);
  return eSorted.every((v, i) => v === gSorted[i]);
}

// ─── CLI args ────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const LABEL_SET = flag('label-set', '');

// ─── Main ────────────────────────────────────────────

async function main() {
  // Load reviewed labels, optionally filtered by label set
  const conditions = [eq(schema.messageLabels.reviewed, true)];
  if (LABEL_SET) {
    conditions.push(eq(schema.messageLabels.labelSet, LABEL_SET));
  }

  const rows = await db
    .select({
      label: schema.messageLabels,
      message: schema.messages,
    })
    .from(schema.messageLabels)
    .innerJoin(schema.messages, eq(schema.messageLabels.messageId, schema.messages.id))
    .where(and(...conditions));

  if (rows.length === 0) {
    console.log(LABEL_SET
      ? `No reviewed labels found for label set "${LABEL_SET}".`
      : 'No reviewed labels found. Review some labels in the UI first.');
    return;
  }

  const labelSet = LABEL_SET || rows[0].label.labelSet;
  const modelInfo = rows[0].label.modelProvider
    ? ` [${rows[0].label.modelProvider}/${rows[0].label.modelName}]`
    : '';
  console.log(`\nEval Report (${labelSet}${modelInfo}, ${rows.length} reviewed labels)`);
  console.log('─'.repeat(60));

  const fields: Record<FieldName, FieldResult> = {
    action:      { correct: 0, total: 0 },
    direction:   { correct: 0, total: 0 },
    strategy:    { correct: 0, total: 0 },
    price:       { correct: 0, total: 0 },
    strikes:     { correct: 0, total: 0 },
    quantity:    { correct: 0, total: 0 },
    expiry:      { correct: 0, total: 0 },
    exitPercent: { correct: 0, total: 0 },
  };

  let allCorrect = 0;
  const failures: Failure[] = [];

  for (const { label, message } of rows) {
    const parsed = classifyMessage(message.rawHtml);
    const topStrategy = parsed.detectedStrategies[0];

    let rowAllCorrect = true;

    // Action
    fields.action.total++;
    const parsedAction = normalizeNull(parsed.actionHint);
    const labelAction = normalizeNull(label.action);
    if (parsedAction === labelAction) {
      fields.action.correct++;
    } else {
      rowAllCorrect = false;
      failures.push({
        cleanText: message.cleanText.slice(0, 60),
        field: 'action',
        expected: labelAction ?? 'null',
        got: parsedAction ?? 'null',
      });
    }

    // Direction
    fields.direction.total++;
    const parsedDir = normalizeNull(parsed.directionHint);
    const labelDir = normalizeNull(label.direction);
    if (parsedDir === labelDir) {
      fields.direction.correct++;
    } else {
      rowAllCorrect = false;
      failures.push({
        cleanText: message.cleanText.slice(0, 60),
        field: 'direction',
        expected: labelDir ?? 'null',
        got: parsedDir ?? 'null',
      });
    }

    // Strategy
    fields.strategy.total++;
    const parsedStrat = normalizeNull(topStrategy?.strategy);
    const labelStrat = normalizeNull(label.strategy);
    if (parsedStrat === labelStrat) {
      fields.strategy.correct++;
    } else {
      rowAllCorrect = false;
      failures.push({
        cleanText: message.cleanText.slice(0, 60),
        field: 'strategy',
        expected: labelStrat ?? 'null',
        got: parsedStrat ?? 'null',
      });
    }

    // Price (ingestion path)
    fields.price.total++;
    const parsedPrice = normalizeNull(topStrategy?.price != null ? String(topStrategy.price) : null);
    const labelPrice = normalizeNull(label.price);
    if (priceMatch(labelPrice, parsedPrice)) {
      fields.price.correct++;
    } else {
      rowAllCorrect = false;
      failures.push({
        cleanText: message.cleanText.slice(0, 60),
        field: 'price',
        expected: labelPrice ?? 'null',
        got: parsedPrice ?? 'null',
      });
    }

    // Strikes
    fields.strikes.total++;
    if (strikesMatch(label.strikes, topStrategy?.strikes)) {
      fields.strikes.correct++;
    } else {
      rowAllCorrect = false;
      failures.push({
        cleanText: message.cleanText.slice(0, 60),
        field: 'strikes',
        expected: JSON.stringify(label.strikes ?? []),
        got: JSON.stringify(topStrategy?.strikes ?? []),
      });
    }

    // Quantity
    fields.quantity.total++;
    const parsedQty = normalizeNull(topStrategy?.quantity != null ? String(topStrategy.quantity) : null);
    const labelQty = normalizeNull(label.quantity);
    if (parsedQty === labelQty) {
      fields.quantity.correct++;
    } else {
      rowAllCorrect = false;
      failures.push({
        cleanText: message.cleanText.slice(0, 60),
        field: 'quantity',
        expected: labelQty ?? 'null',
        got: parsedQty ?? 'null',
      });
    }

    // Expiry
    fields.expiry.total++;
    const parsedExpiry = normalizeNull(topStrategy?.expiry);
    const labelExpiry = normalizeNull(label.expiry);
    if (parsedExpiry === labelExpiry) {
      fields.expiry.correct++;
    } else {
      rowAllCorrect = false;
      failures.push({
        cleanText: message.cleanText.slice(0, 60),
        field: 'expiry',
        expected: labelExpiry ?? 'null',
        got: parsedExpiry ?? 'null',
      });
    }

    // Exit percent (only compare when label has an exit percent)
    if (label.exitPercent != null) {
      fields.exitPercent.total++;
      // Ingestion parser doesn't extract exitPercent — only agent labels will have it
      // For now, mark as N/A unless we have a parsed exit percent to compare
      const parsedExitPct: number | null = null; // ingestion parser doesn't produce this
      const tolerance = 0.1; // ±10% tolerance
      if (parsedExitPct != null && Math.abs(parsedExitPct - label.exitPercent) <= tolerance) {
        fields.exitPercent.correct++;
      } else if (parsedExitPct == null) {
        // Don't count as a failure if the parser doesn't produce exit percent
        fields.exitPercent.total--;
      } else {
        rowAllCorrect = false;
        failures.push({
          cleanText: message.cleanText.slice(0, 60),
          field: 'exitPercent',
          expected: String(label.exitPercent),
          got: String(parsedExitPct),
        });
      }
    }

    if (rowAllCorrect) allCorrect++;
  }

  // Print summary
  const overallPct = ((allCorrect / rows.length) * 100).toFixed(1);
  console.log(`Overall accuracy:    ${overallPct}%  (${allCorrect}/${rows.length} all fields match)`);
  console.log('─'.repeat(60));

  console.log('\nIngestion Parser:');
  console.log(`${'  Field'.padEnd(16)} ${'Correct'.padStart(8)} ${'Total'.padStart(8)} ${'Accuracy'.padStart(10)}`);
  for (const name of ['action', 'direction', 'strategy', 'price', 'strikes', 'quantity', 'expiry', 'exitPercent'] as FieldName[]) {
    const result = fields[name];
    const pct = result.total > 0 ? ((result.correct / result.total) * 100).toFixed(1) : 'N/A';
    console.log(
      `${'  ' + name.padEnd(14)} ${String(result.correct).padStart(8)} ${String(result.total).padStart(8)} ${(pct + '%').padStart(10)}`
    );
  }

  // Compute accuracy values for persistence
  function accuracy(f: FieldResult): number | null {
    return f.total > 0 ? f.correct / f.total : null;
  }

  const totalMislabelings = failures.length;

  // Persist to eval_runs table
  const runId = crypto.randomUUID();
  await db.insert(schema.evalRuns).values({
    id: runId,
    labelSet,
    ranAt: new Date().toISOString(),
    totalLabels: rows.length,
    actionAccuracy: accuracy(fields.action),
    directionAccuracy: accuracy(fields.direction),
    strategyAccuracy: accuracy(fields.strategy),
    priceAccuracy: accuracy(fields.price),
    exitPriceAccuracy: null,
    strikesAccuracy: accuracy(fields.strikes),
    overallAccuracy: allCorrect / rows.length,
    totalMislabelings,
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
