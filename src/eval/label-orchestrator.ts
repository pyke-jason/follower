#!/usr/bin/env npx tsx

/**
 * Label Orchestrator — spins up N Claude Code instances in parallel to label messages.
 *
 * Usage:
 *   npx tsx src/eval/label-orchestrator.ts --count 50 --workers 5
 *
 * Logs stream to console with [W1] [W2] prefixes, and each worker's full output
 * is written to .cache/label-logs/worker-N.log for inspection.
 */

import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { db, schema } from '../db/client.js';
import { sql } from 'drizzle-orm';

// ─── CLI args ────────────────────────────────────────

const cliArgs = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const idx = cliArgs.indexOf(`--${name}`);
  return idx !== -1 && cliArgs[idx + 1] ? cliArgs[idx + 1] : fallback;
}

const COUNT = parseInt(flag('count', '50'), 10);
const WORKERS = parseInt(flag('workers', '5'), 10);
const LABEL_SET = flag('label-set', 'baseline');
const MODEL = flag('model', 'sonnet');
const LOG_DIR = '.cache/label-logs';

// ─── Colors for worker tags ─────────────────────────

const COLORS = [
  '\x1b[36m',  // cyan
  '\x1b[33m',  // yellow
  '\x1b[35m',  // magenta
  '\x1b[32m',  // green
  '\x1b[34m',  // blue
  '\x1b[91m',  // bright red
  '\x1b[93m',  // bright yellow
  '\x1b[95m',  // bright magenta
];
const RESET = '\x1b[0m';

function colorTag(workerNum: number): string {
  const color = COLORS[(workerNum - 1) % COLORS.length];
  return `${color}[W${workerNum}]${RESET}`;
}

// ─── Fetch unlabeled messages ────────────────────────

const unlabeled = await db.all<{
  id: string;
  author: string;
  clean_text: string;
  badges: string;
  symbols: string;
  timestamp: string;
}>(sql`
  SELECT m.id, m.author, m.clean_text, m.badges, m.symbols, m.timestamp
  FROM messages m
  LEFT JOIN message_labels ml ON ml.message_id = m.id AND ml.label_set = ${LABEL_SET}
  WHERE json_array_length(m.badges) > 0
    AND ml.id IS NULL
  ORDER BY m.timestamp ASC
  LIMIT ${COUNT}
`);

if (unlabeled.length === 0) {
  console.log('No unlabeled messages found.');
  process.exit(0);
}

console.log(`Found ${unlabeled.length} unlabeled messages. Splitting across ${WORKERS} workers.\n`);

// ─── Split into chunks ──────────────────────────────

function splitChunks<T>(arr: T[], n: number): T[][] {
  const size = Math.ceil(arr.length / n);
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

const chunks = splitChunks(unlabeled, WORKERS);

// ─── Build prompt for each worker ────────────────────

function buildPrompt(messages: typeof unlabeled): string {
  const messageList = messages.map((m) => {
    const badges = JSON.parse(m.badges || '[]');
    const symbols = JSON.parse(m.symbols || '[]');
    return `- ID: ${m.id}\n  Author: ${m.author}\n  Text: ${m.clean_text}\n  Badges: ${JSON.stringify(badges)}\n  Symbols: ${JSON.stringify(symbols)}\n  Time: ${m.timestamp}`;
  }).join('\n\n');

  return `You are labeling trade messages. For each message below, use the MCP label tools to classify it:

1. For each message, call get_nearby_messages with the message ID to see context
2. If it looks like a close/trim/add, call get_trader_position_history
3. Then call submit_label with your classification

Label set: "${LABEL_SET}"

Strategy guide:
- CDS = Call Debit Spread (buy lower strike call, sell higher strike call)
- PDS = Put Debit Spread (buy higher strike put, sell lower strike put)
- "Added"/"Adding" = action OPEN (adding to existing position)
- "Trim"/"Trimmed"/"Sold half" = action CLOSE (partial exit)
- "Out"/"Closed"/"Exited" = action CLOSE (full exit)

Messages to label:

${messageList}

Label ALL ${messages.length} messages above. Work through them one at a time. For each one, use the tools then call submit_label.`;
}

// ─── Spawn workers ───────────────────────────────────

await mkdir(LOG_DIR, { recursive: true });

function spawnWorker(workerNum: number, prompt: string): Promise<{ worker: number; exitCode: number; labeled: number }> {
  return new Promise((resolve) => {
    const tag = colorTag(workerNum);
    const plainTag = `[W${workerNum}]`;
    const logPath = `${LOG_DIR}/worker-${workerNum}.log`;
    const logStream = createWriteStream(logPath);

    console.log(`${tag} Starting with ${chunks[workerNum - 1].length} messages → ${logPath}`);

    const child = spawn('claude', [
      '--print',
      '--model', MODEL,
      '--max-turns', '100',
      '--verbose',
      prompt,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined },
    });

    let labelCount = 0;

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      logStream.write(text);

      // Parse output for interesting events and print them
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.includes('submit_label')) {
          labelCount++;
          console.log(`${tag} ✓ Label #${labelCount} submitted`);
        } else if (trimmed.includes('get_nearby_messages')) {
          // Show which message is being worked on
          const idMatch = trimmed.match(/[a-f0-9-]{36}/);
          if (idMatch) {
            console.log(`${tag} Investigating ${idMatch[0].slice(0, 8)}...`);
          }
        } else if (trimmed.includes('Error') || trimmed.includes('error')) {
          console.log(`${tag} ${trimmed.slice(0, 120)}`);
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      logStream.write(`[stderr] ${text}`);

      // Show MCP/tool activity from stderr
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Show tool calls and results
        if (trimmed.includes('Tool:') || trimmed.includes('tool_use') || trimmed.includes('MCP')) {
          console.log(`${tag} ${trimmed.slice(0, 150)}`);
        }
      }
    });

    child.on('close', (code) => {
      logStream.end();
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        console.error(`${tag} ✗ Exited with code ${exitCode} (see ${logPath})`);
      } else {
        console.log(`${tag} ✓ Done — ${labelCount} labels submitted`);
      }
      resolve({ worker: workerNum, exitCode, labeled: labelCount });
    });

    child.on('error', (err) => {
      logStream.end();
      console.error(`${tag} ✗ Failed to spawn: ${err.message}`);
      resolve({ worker: workerNum, exitCode: 1, labeled: 0 });
    });
  });
}

// ─── Run all workers in parallel ─────────────────────

console.log(`\nLaunching ${chunks.length} workers (model: ${MODEL})...\n`);
console.log(`Logs: ${LOG_DIR}/worker-{1..${chunks.length}}.log\n`);

const results = await Promise.all(
  chunks.map((c, i) => spawnWorker(i + 1, buildPrompt(c)))
);

// ─── Summary ─────────────────────────────────────────

console.log('\n' + '─'.repeat(50));

const totalLabeled = results.reduce((sum, r) => sum + r.labeled, 0);
const succeeded = results.filter((r) => r.exitCode === 0).length;
const failed = results.filter((r) => r.exitCode !== 0).length;

console.log(`Workers: ${succeeded} succeeded, ${failed} failed`);
console.log(`Labels submitted: ${totalLabeled}`);

// Verify against DB
const dbCount = await db.all<{ count: number }>(sql`
  SELECT COUNT(*) as count FROM message_labels WHERE label_set = ${LABEL_SET}
`);
console.log(`Labels in DB ("${LABEL_SET}"): ${dbCount[0]?.count ?? 0}`);
console.log(`Full logs: ${LOG_DIR}/`);
