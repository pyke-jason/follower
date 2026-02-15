import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { db, schema } from '../db/client.js';
import { sql } from 'drizzle-orm';
import { createProvider, DEFAULT_LABEL_MODEL } from '../agent/providers.js';
import type { ModelProvider } from '../agent/providers.js';

// ─── CLI args ────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const COUNT = parseInt(flag('count', '100'), 10);
const LABEL_SET = flag('label-set', 'baseline');
const PROVIDER = flag('provider', DEFAULT_LABEL_MODEL.provider) as ModelProvider;
const MODEL = flag('model', PROVIDER === 'anthropic' ? DEFAULT_LABEL_MODEL.model : 'grok-3');
const BATCH_SIZE = 10;

// ─── Main ────────────────────────────────────────────

async function main() {
  const provider = await createProvider({ provider: PROVIDER, model: MODEL });
  console.log(`Using ${provider.identity.provider}/${provider.identity.model}`);

  // Fetch badged messages that don't have a label yet
  const unlabeled = await db.all<{
    id: string;
    clean_text: string;
    badges: string;
    symbols: string;
    raw_html: string;
  }>(sql`
    SELECT m.id, m.clean_text, m.badges, m.symbols, m.raw_html
    FROM messages m
    LEFT JOIN message_labels ml ON ml.message_id = m.id
    WHERE json_array_length(m.badges) > 0
      AND ml.id IS NULL
    ORDER BY RANDOM()
    LIMIT ${COUNT}
  `);

  if (unlabeled.length === 0) {
    console.log('No unlabeled badged messages found.');
    return;
  }

  console.log(`Found ${unlabeled.length} unlabeled messages. Labeling in batches of ${BATCH_SIZE}...`);

  let totalLabeled = 0;

  for (let i = 0; i < unlabeled.length; i += BATCH_SIZE) {
    const batch = unlabeled.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(unlabeled.length / BATCH_SIZE);

    console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} messages)...`);

    const messagesPayload = batch.map((m) => ({
      id: m.id,
      cleanText: m.clean_text,
      badges: JSON.parse(m.badges || '[]'),
      symbols: JSON.parse(m.symbols || '[]'),
      rawHtml: m.raw_html,
    }));

    const prompt = `You are a trade message classifier. For each message, determine the ground truth trade label.

Analyze each message and return a JSON array with one object per message, in the same order.

Each object must have these fields:
- id: the message id (string, copy from input)
- isTrade: boolean - is this a real trade alert/signal?
- action: "OPEN" | "CLOSE" | null - is the trader opening or closing a position?
- direction: "LONG" | "SHORT" | null - long or short?
- strategy: "STOCK" | "CALL" | "PUT" | "CDS" | "PDS" | null - what type of trade?
  - CDS = Call Debit Spread, PDS = Put Debit Spread
  - CALL/PUT = single option leg
  - STOCK = shares/equity
- symbol: string | null - the ticker symbol (uppercase, e.g. "AAPL")
- price: string | null - the entry/exit price as text, null if ambiguous or not stated
- strikes: number[] | null - option strike prices if applicable
- quantity: string | null - number of contracts/shares if stated
- expiry: string | null - option expiration date in ISO format (YYYY-MM-DD) if applicable
- notes: string | null - brief note about anything unusual or ambiguous

Rules:
- If a message discusses a trade but is ambiguous, set isTrade=true and leave ambiguous fields null
- "Trim" or "scale" messages are partial closes — action=CLOSE
- Messages with "Added" or "Adding" are additional entries — action=OPEN
- Look at badges for context: badges often indicate the trade type

Return ONLY a JSON array, no markdown fences or extra text.

Messages to classify:
${JSON.stringify(messagesPayload, null, 2)}`;

    try {
      const response = await provider.chat({
        messages: [provider.makeUserMessage(prompt)],
        maxTokens: 4096,
      });

      const text = response.textBlocks.join('');

      let labels: Array<{
        id: string;
        isTrade: boolean;
        action: string | null;
        direction: string | null;
        strategy: string | null;
        symbol: string | null;
        price: string | null;
        strikes: number[] | null;
        quantity: string | null;
        expiry: string | null;
        notes: string | null;
      }>;

      try {
        labels = JSON.parse(text);
      } catch {
        console.error(`  Failed to parse response JSON. Skipping batch.`);
        console.error(`  Response: ${text.slice(0, 200)}...`);
        continue;
      }

      if (!Array.isArray(labels)) {
        console.error(`  Response was not an array. Skipping batch.`);
        continue;
      }

      // Insert labels
      for (const label of labels) {
        const msg = batch.find((m) => m.id === label.id);
        if (!msg) {
          console.error(`  Unknown message id: ${label.id}`);
          continue;
        }

        await db.insert(schema.messageLabels).values({
          messageId: label.id,
          labelSet: LABEL_SET,
          isTrade: label.isTrade ?? null,
          action: label.action ?? null,
          direction: label.direction ?? null,
          strategy: label.strategy ?? null,
          symbol: label.symbol ?? null,
          price: label.price ?? null,
          strikes: label.strikes ?? null,
          quantity: label.quantity ?? null,
          expiry: label.expiry ?? null,
          source: 'agent',
          reviewed: false,
          notes: label.notes ?? null,
          modelProvider: provider.identity.provider,
          modelName: provider.identity.model,
        });
      }

      totalLabeled += labels.length;
      console.log(`  Labeled ${labels.length} messages (${totalLabeled} total)`);
    } catch (err) {
      console.error(`  API error:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nDone! Labeled ${totalLabeled} messages with label set "${LABEL_SET}".`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
