#!/usr/bin/env tsx
/**
 * Classification-audit triage cron.
 *
 * Replaces a broken external scheduled task (already disabled). Every 5 minutes:
 *
 *   1. Acquire /tmp/follower-triage.lock (skip tick if previous run still going).
 *   2. Read cursor at ~/.cache/follower-triage-cursor.json.
 *   3. Query `classification_audits` for rows newer than the cursor (cap 20/tick).
 *   4. Spawn `claude -p` with the triage prompt + audit JSON, 10-min wall clock.
 *   5. Parse the agent's `TRIAGE_RESULT=<json>` marker line.
 *   6. On agent exit code 0, advance the cursor atomically to max(createdAt) of the batch.
 *   7. Print a per-tick structured summary; release the lock.
 *
 * Usage:
 *   npm run triage          # supervised loop, every 5 min
 *   npm run triage:once     # single tick, exit
 *
 * Disable: do not run `npm run triage`. This script is NOT part of `dev-up.ts`,
 * so the orchestrator does not start or supervise it.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asc, gt } from 'drizzle-orm';

import { loadSecrets } from '../src/lib/secrets/index.js';
import { acquireLock, releaseLock } from '../src/lib/pidlock.js';
import { renderTriagePrompt } from '../src/triage/prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const BATCH_LIMIT = 20;
const LOCK_PATH = resolve(tmpdir(), 'follower-triage.lock');
const CURSOR_PATH = resolve(homedir(), '.cache', 'follower-triage-cursor.json');
const RESULT_MARKER = 'TRIAGE_RESULT=';

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.log(`[triage ${ts()}] ${msg}`);
}

function logErr(msg: string): void {
  console.error(`[triage ${ts()}] ${msg}`);
}

// ─── Cursor (atomic write) ──────────────────────────

type Cursor = { lastCreatedAt: string };

function readCursor(): Cursor {
  try {
    const raw = readFileSync(CURSOR_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    if (typeof parsed.lastCreatedAt === 'string') return { lastCreatedAt: parsed.lastCreatedAt };
  } catch {
    // missing or unreadable — treat as epoch
  }
  return { lastCreatedAt: '1970-01-01T00:00:00.000Z' };
}

function writeCursor(next: Cursor): void {
  mkdirSync(dirname(CURSOR_PATH), { recursive: true });
  const tmp = `${CURSOR_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next), 'utf-8');
  renameSync(tmp, CURSOR_PATH);
}

// ─── Agent invocation ──────────────────────────────

type ProcessedItem = {
  audit_id: string;
  decision: 'FIX_CODE' | 'FIX_PROMPT' | 'SKIP_NOISY' | 'SKIP_DUPLICATE' | 'ESCALATE';
  sha: string | null;
  files: string[];
  note: string;
};

type FailedItem = { audit_id: string; reason: string };

type TriageResult = { processed: ProcessedItem[]; failed: FailedItem[] };

function parseAgentResult(stdout: string): TriageResult | null {
  // Marker may not be the absolute final line if `claude --output-format json` wraps
  // the agent text in a JSON envelope; scan all lines for the marker substring.
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const idx = line.indexOf(RESULT_MARKER);
    if (idx === -1) continue;
    const jsonText = line.slice(idx + RESULT_MARKER.length).trim();
    // Strip a trailing JSON-quote/brace if the marker was embedded in a quoted string.
    const cleaned = jsonText.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    try {
      const parsed = JSON.parse(cleaned) as TriageResult;
      if (Array.isArray(parsed.processed) && Array.isArray(parsed.failed)) return parsed;
    } catch {
      // Try the raw substring up to the matching closing brace
      try {
        const parsed = JSON.parse(jsonText) as TriageResult;
        if (Array.isArray(parsed.processed) && Array.isArray(parsed.failed)) return parsed;
      } catch {
        // fall through, try earlier lines
      }
    }
  }
  return null;
}

function spawnAgent(prompt: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--permission-mode', 'bypassPermissions',
        '--output-format', 'json',
        prompt,
      ],
      { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

    const killTimer = setTimeout(() => {
      timedOut = true;
      logErr(`agent exceeded ${AGENT_TIMEOUT_MS / 1000}s — sending SIGTERM`);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) {
          logErr('agent did not exit on SIGTERM — sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, 10_000);
    }, AGENT_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// ─── Tick ───────────────────────────────────────────

async function runTick(): Promise<void> {
  const lock = acquireLock(LOCK_PATH);
  if (!lock.acquired) {
    log(`skipping tick — previous run still holding lock (PID ${lock.existingPid})`);
    return;
  }

  try {
    // DB client must load lazily — it reads POSTGRES_DATABASE_URL at import time.
    const { db, schema } = await import('../src/db/client.js');

    const cursor = readCursor();
    const rows = await db
      .select({
        id: schema.classificationAudits.id,
        channelId: schema.classificationAudits.channelId,
        messageId: schema.classificationAudits.messageId,
        runDecisionId: schema.classificationAudits.runDecisionId,
        auditKind: schema.classificationAudits.auditKind,
        severity: schema.classificationAudits.severity,
        status: schema.classificationAudits.status,
        category: schema.classificationAudits.category,
        title: schema.classificationAudits.title,
        details: schema.classificationAudits.details,
        findings: schema.classificationAudits.findings,
        createdAt: schema.classificationAudits.createdAt,
      })
      .from(schema.classificationAudits)
      .where(gt(schema.classificationAudits.createdAt, cursor.lastCreatedAt))
      .orderBy(asc(schema.classificationAudits.createdAt))
      .limit(BATCH_LIMIT);

    if (rows.length === 0) {
      log(`no new audits since ${cursor.lastCreatedAt}`);
      return;
    }

    const maxCreatedAt = rows.reduce(
      (acc, r) => (r.createdAt && r.createdAt > acc ? r.createdAt : acc),
      cursor.lastCreatedAt,
    );

    log(`pulled ${rows.length} audit(s); cursor ${cursor.lastCreatedAt} → would advance to ${maxCreatedAt}`);

    const prompt = renderTriagePrompt(JSON.stringify(rows, null, 2));
    const { code, stdout, stderr, timedOut } = await spawnAgent(prompt);

    if (timedOut) {
      logErr('agent timed out — cursor NOT advanced; will retry these audits next tick');
      return;
    }
    if (code !== 0) {
      logErr(`agent exited ${code} — cursor NOT advanced; stderr tail: ${stderr.slice(-500)}`);
      return;
    }

    const result = parseAgentResult(stdout);
    if (!result) {
      logErr('agent finished but no TRIAGE_RESULT marker found — cursor NOT advanced');
      logErr(`stdout tail: ${stdout.slice(-500)}`);
      return;
    }

    // Per-decision summary
    const byDecision: Record<string, number> = {};
    for (const p of result.processed) byDecision[p.decision] = (byDecision[p.decision] ?? 0) + 1;
    const summary = Object.entries(byDecision).map(([k, v]) => `${k}=${v}`).join(' ');
    log(
      `tick complete: pulled=${rows.length} processed=${result.processed.length} failed=${result.failed.length} (${summary || 'none'})`,
    );
    for (const p of result.processed) {
      const shaPart = p.sha ? ` sha=${p.sha.slice(0, 10)}` : '';
      const filesPart = p.files.length ? ` files=${p.files.join(',')}` : '';
      log(`  ${p.decision} audit=${p.audit_id}${shaPart}${filesPart}${p.note ? ` — ${p.note}` : ''}`);
    }
    for (const f of result.failed) {
      log(`  FAILED audit=${f.audit_id} reason=${f.reason}`);
    }

    writeCursor({ lastCreatedAt: maxCreatedAt });
    log(`cursor advanced to ${maxCreatedAt}`);
  } finally {
    releaseLock(LOCK_PATH);
  }
}

// ─── Main loop ──────────────────────────────────────

let stopped = false;

async function main(): Promise<void> {
  await loadSecrets();

  log(`starting (mode=${ONCE ? 'once' : 'loop'} interval=${TICK_INTERVAL_MS / 1000}s lock=${LOCK_PATH} cursor=${CURSOR_PATH})`);

  if (ONCE) {
    await runTick();
    return;
  }

  // Run immediately on startup, then every TICK_INTERVAL_MS.
  while (!stopped) {
    const tickStart = Date.now();
    try {
      await runTick();
    } catch (err) {
      const e = err instanceof Error ? (err.stack ?? err.message) : String(err);
      logErr(`tick threw: ${e}`);
    }
    if (stopped) break;

    const elapsed = Date.now() - tickStart;
    const wait = Math.max(0, TICK_INTERVAL_MS - elapsed);
    await new Promise<void>((r) => {
      const t = setTimeout(r, wait);
      const onSig = () => { clearTimeout(t); r(); };
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);
    });
  }
}

function shutdown(sig: string): void {
  if (stopped) return;
  stopped = true;
  log(`received ${sig} — exiting after current tick (if any)`);
  // Best-effort lock release in case we were idle between ticks.
  releaseLock(LOCK_PATH);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const e = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logErr(`fatal: ${e}`);
    releaseLock(LOCK_PATH);
    process.exit(1);
  });
