import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { loadSecrets } from '../src/lib/secrets/index.js';

type CorpusRow = {
  messageId: string;
  author: string;
  timestamp: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
};

const projectRoot = resolve(import.meta.dirname, '..');
await loadSecrets();
const databaseUrl = process.env.POSTGRES_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://jason@127.0.0.1:5432/trade_follower';
if (databaseUrl.startsWith('file:')) {
  throw new Error('Postgres export requires POSTGRES_DATABASE_URL, not file-backed DATABASE_URL');
}
const outputPath = resolve(
  projectRoot,
  'src',
  'intents',
  'orchestrator',
  '__fixtures__',
  'no-badge-trade-corpus.json',
);

const pool = new pg.Pool({ connectionString: databaseUrl, allowExitOnIdle: true });

const { rows } = await pool.query<{
  messageId: string;
  author: string;
  timestamp: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
}>(`
  select
    e.message_id as "messageId",
    m.author as author,
    m.timestamp as timestamp,
    m.clean_text as "cleanText",
    m.badges as badges,
    m.symbols as symbols
  from eval_labels e
  inner join messages m on m.id = e.message_id
  where (coalesce(e.human_label, e.label)->>'isTrade')::boolean is true
    and not m.badges ?| array['Long', 'Short', 'Exit']
  order by m.timestamp asc, e.message_id asc
`);
await pool.end();

const corpus: CorpusRow[] = rows.map((row) => ({
  messageId: row.messageId,
  author: row.author,
  timestamp: row.timestamp,
  cleanText: row.cleanText,
  badges: row.badges,
  symbols: row.symbols,
}));

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(corpus, null, 2)}\n`);
console.log(`Wrote ${corpus.length} cases to ${outputPath}`);
