import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

type CorpusRow = {
  messageId: string;
  author: string;
  timestamp: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
};

const projectRoot = resolve(import.meta.dirname, '..');
const dbPath = resolve(projectRoot, 'data', 'trade-follower.db');
const outputPath = resolve(
  projectRoot,
  'src',
  'intents',
  'orchestrator',
  '__fixtures__',
  'no-badge-trade-corpus.json',
);

const sqlite = new Database(dbPath, { readonly: true });

const rows = sqlite.prepare(`
  select
    e.message_id as messageId,
    m.author as author,
    m.timestamp as timestamp,
    m.clean_text as cleanText,
    m.badges as badges,
    m.symbols as symbols
  from eval_labels e
  inner join messages m on m.id = e.message_id
  where json_extract(coalesce(e.human_label, e.label), '$.isTrade') = 1
    and not exists (
      select 1
      from json_each(m.badges)
      where value in ('Long', 'Short', 'Exit')
    )
  order by m.timestamp asc, e.message_id asc
`).all() as Array<{
  messageId: string;
  author: string;
  timestamp: string;
  cleanText: string;
  badges: string;
  symbols: string;
}>;

const corpus: CorpusRow[] = rows.map((row) => ({
  messageId: row.messageId,
  author: row.author,
  timestamp: row.timestamp,
  cleanText: row.cleanText,
  badges: JSON.parse(row.badges) as string[],
  symbols: JSON.parse(row.symbols) as string[],
}));

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(corpus, null, 2)}\n`);
console.log(`Wrote ${corpus.length} cases to ${outputPath}`);
