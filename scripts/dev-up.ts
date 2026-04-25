#!/usr/bin/env tsx
/**
 * Dev startup orchestrator.
 *
 * Reads runtime channel config (same path as the app) to decide which
 * services to launch, then spawns them in dependency order with health gates.
 *
 * Usage:
 *   npx tsx scripts/dev-up.ts            # full stack
 *   npx tsx scripts/dev-up.ts --no-backend   # api + web only
 *   npx tsx scripts/dev-up.ts --no-ibkr      # skip gateway/sidecar even if configured
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendSystemAlert } from '../src/lib/alert.js';
import { startBatteryMonitor } from '../src/lib/battery-monitor.js';
import { createRollingFileStream } from '../src/lib/log-rotation.js';
import { PATHS } from '../src/lib/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS ?? '14', 10);

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

const terminalLog = createRollingFileStream({ dir: PATHS.logs, prefix: 'terminal' });

function writeTerminalLine(line: string): void {
  const ts = new Date().toISOString();
  terminalLog.write(`${ts} ${stripAnsi(line)}\n`);
}

// ─── Args ────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const NO_BACKEND = args.has('--no-backend');
const NO_IBKR = args.has('--no-ibkr');

// ─── Colors ──────────────────────────────────────────

const COLORS: Record<string, string> = {
  api:     '\x1b[36m',  // cyan
  web:     '\x1b[35m',  // magenta
  backend: '\x1b[33m',  // yellow
  gateway: '\x1b[32m',  // green
  sidecar: '\x1b[34m',  // blue
  orch:    '\x1b[90m',  // gray
};
const RESET = '\x1b[0m';

function log(tag: string, msg: string): void {
  const color = COLORS[tag] ?? '';
  console.log(`${color}[${tag}]${RESET} ${msg}`);
  writeTerminalLine(`[${tag}] ${msg}`);
}

// ─── Process management ──────────────────────────────

type ManagedProcess = {
  name: string;
  proc: ChildProcess;
};

const children: ManagedProcess[] = [];
let shuttingDown = false;

function spawnService(
  name: string,
  cmd: string,
  cmdArgs: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): ChildProcess {
  const child = spawn(cmd, cmdArgs, {
    cwd: opts?.cwd ?? ROOT,
    env: { ...process.env, ...opts?.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = (stream: 'stdout' | 'stderr') => {
    child[stream]?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) log(name, line);
      }
    });
  };
  prefix('stdout');
  prefix('stderr');

  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      log('orch', `${name} exited (code=${code}, signal=${signal})`);
      if (name === 'api') {
        log('orch', 'Critical service api died — shutting down');
        shutdown();
      }
      // Backend auto-restarts (see superviseBackend)
    }
  });

  children.push({ name, proc: child });
  log('orch', `Started ${name} (PID ${child.pid})`);
  return child;
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('orch', 'Shutting down all services...');

  // Send SIGTERM to all children (reverse order)
  for (const { name, proc } of [...children].reverse()) {
    if (proc.exitCode === null && !proc.killed) {
      log('orch', `Stopping ${name} (PID ${proc.pid})`);
      proc.kill('SIGTERM');
    }
  }

  // Wait up to 5s for graceful exit
  await Promise.race([
    Promise.all(
      children.map(
        ({ proc }) =>
          new Promise<void>((res) => {
            if (proc.exitCode !== null) return res();
            proc.on('exit', () => res());
          }),
      ),
    ),
    new Promise<void>((res) => setTimeout(res, 5_000)),
  ]);

  // Force kill survivors
  for (const { name, proc } of children) {
    if (proc.exitCode === null && !proc.killed) {
      log('orch', `Force killing ${name}`);
      proc.kill('SIGKILL');
    }
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  writeTerminalLine(`[orch] uncaughtException ${err.stack ?? err.message}`);
  console.error('Uncaught exception:', err);
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  const r = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  writeTerminalLine(`[orch] unhandledRejection ${r}`);
  console.error('Unhandled rejection:', reason);
});

// ─── Log retention ───────────────────────────────────

function pruneOldLogs(maxAgeDays: number): void {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let freedBytes = 0;
  try {
    for (const name of readdirSync(PATHS.logs)) {
      const p = join(PATHS.logs, name);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        if (st.mtimeMs < cutoff) {
          freedBytes += st.size;
          unlinkSync(p);
          removed++;
        }
      } catch {
        // entry vanished between readdir and stat — ignore
      }
    }
  } catch {
    // no .logs dir yet — nothing to prune
    return;
  }
  if (removed > 0) {
    log('orch', `Pruned ${removed} log file(s) older than ${maxAgeDays}d (${(freedBytes / 1024 / 1024).toFixed(1)} MB)`);
  }
}

// ─── Health checks ───────────────────────────────────

async function waitForHealth(
  label: string,
  url: string,
  opts?: { check?: (body: unknown) => boolean; timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const timeout = opts?.timeoutMs ?? 30_000;
  const interval = opts?.intervalMs ?? 1_000;
  const check = opts?.check ?? (() => true);
  const deadline = Date.now() + timeout;

  log('orch', `Waiting for ${label} at ${url}...`);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) {
        const body = await res.json();
        if (check(body)) {
          log('orch', `${label} is ready`);
          return true;
        }
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  log('orch', `${label} did not become ready within ${timeout / 1000}s`);
  return false;
}

// ─── Channel detection ───────────────────────────────

type ChannelInfo = {
  hasIbkr: boolean;
  ibkrMode: 'live' | 'paper';
  ibkrAccountId: string;
  sidecarUrl: string;
  channelSummary: string[];
};

async function detectChannels(): Promise<ChannelInfo> {
  // Load secrets into process.env exactly like the app does
  const { loadSecrets } = await import('../src/lib/secrets/index.js');
  await loadSecrets();

  // Now read channel definitions (they read from process.env)
  const { getRuntimeChannelDefinitions } = await import('../src/lib/runtime-channels.js');

  let defs: { brokerName: string; label: string; mode?: string; sidecarUrl?: string; accountId?: string }[];
  try {
    defs = getRuntimeChannelDefinitions();
  } catch {
    // No channels configured — that's okay for --no-backend mode
    defs = [];
  }

  const ibkrDefs = defs.filter((d) => d.brokerName === 'ibkr');
  const sidecarUrl = ibkrDefs[0]?.sidecarUrl ?? 'http://localhost:8090/api';

  const rawMode = ibkrDefs[0]?.mode;
  if (ibkrDefs.length > 0 && rawMode !== 'paper' && rawMode !== 'live') {
    throw new Error(
      `IBKR channel mode must be 'paper' or 'live', got: ${JSON.stringify(rawMode)}. Check ENABLED_CHANNEL_IDS and channel env vars.`,
    );
  }
  const ibkrMode = (rawMode ?? 'paper') as 'live' | 'paper';
  const ibkrAccountId = ibkrDefs[0]?.accountId ?? '';

  return {
    hasIbkr: ibkrDefs.length > 0,
    ibkrMode,
    ibkrAccountId,
    sidecarUrl,
    channelSummary: defs.map((d) => d.label),
  };
}

// ─── Backend supervisor ─────────────────────────────

const BACKEND_MAX_RESTARTS = 10;
const BACKEND_RESTART_DELAYS = [5_000, 10_000, 20_000, 30_000, 60_000]; // cap at 60s

/**
 * Supervises the backend process with automatic restarts.
 * OOM kills (exit 137), crashes, and unexpected exits trigger a restart.
 * Resets the restart counter after 5 minutes of stable running.
 */
async function superviseBackend(): Promise<void> {
  let restartCount = 0;

  const startBackend = (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    return new Promise((resolve) => {
      const child = spawnService('backend', 'npx', ['tsx', 'src/index.ts'], {
        env: { LOG_PROCESS_NAME: 'backend' },
      });
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
  };

  while (!shuttingDown) {
    const startTime = Date.now();
    log('orch', `Starting backend (attempt ${restartCount + 1})...`);

    const { code: exitCode, signal } = await startBackend();
    if (shuttingDown) break;

    // A clean exit is intentional shutdown, not a crash. Common cases:
    // - user started a fresh orchestrator, which SIGTERMed the old backend
    // - the backend handled SIGINT/SIGTERM and exited 0 after draining
    if (exitCode === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
      log('orch', `Backend exited cleanly (${signal ?? `exit code ${exitCode}`}) — not restarting`);
      return;
    }

    const uptime = Date.now() - startTime;
    const uptimeStr = uptime > 60_000
      ? `${Math.round(uptime / 60_000)}m`
      : `${Math.round(uptime / 1_000)}s`;

    // If it ran for >5 minutes, reset the restart counter (it was stable)
    if (uptime > 5 * 60_000) {
      restartCount = 0;
    }

    restartCount++;
    if (restartCount > BACKEND_MAX_RESTARTS) {
      log('orch', `Backend failed ${BACKEND_MAX_RESTARTS} times — giving up. Manual intervention required.`);
      sendSystemAlert({
        title: 'Backend supervisor exhausted',
        message: `Backend crashed ${BACKEND_MAX_RESTARTS} times. Last exit code: ${exitCode}. Manual restart required.`,
        severity: 'critical',
      });
      return;
    }

    const delay = BACKEND_RESTART_DELAYS[Math.min(restartCount - 1, BACKEND_RESTART_DELAYS.length - 1)];
    const reason = exitCode === 137 ? 'OOM killed' : signal ? `signal ${signal}` : `exit code ${exitCode}`;
    log('orch', `Backend died after ${uptimeStr} (${reason}) — restarting in ${delay / 1000}s (attempt ${restartCount}/${BACKEND_MAX_RESTARTS})`);

    sendSystemAlert({
      title: 'Backend restarting',
      message: `Backend ${reason} after ${uptimeStr}. Auto-restarting (attempt ${restartCount}/${BACKEND_MAX_RESTARTS}).`,
      severity: 'warning',
    });

    await new Promise((r) => setTimeout(r, delay));
  }
}

// ─── Sidecar supervisor ─────────────────────────────

const SIDECAR_RESTART_DELAY_MS = 10_000;

async function superviseSidecar(sidecarBase: string, mode: 'live' | 'paper', expectedAccountId: string): Promise<void> {
  const sidecarStatusUrl = `${sidecarBase}/status`;

  const isSidecarConnected = async (): Promise<boolean> => {
    try {
      const res = await fetch(sidecarStatusUrl, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return false;
      const body = (await res.json()) as { connected?: boolean; accountId?: string };
      if (body.connected !== true) return false;
      if (expectedAccountId && body.accountId !== expectedAccountId) {
        log('orch', `SAFETY: sidecar connected to wrong account (got=${body.accountId}, expected=${expectedAccountId}) — treating as not ready`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const startGatewayAndSidecar = async (): Promise<void> => {
    killOnPort(8090, 'sidecar');

    log('orch', `Starting IB Gateway (${mode} mode)...`);
    // The IBC wrapper's path-based mode detection uses a stale absolute path
    // and otherwise defaults TRADING_MODE=live, which rejects paper credentials.
    spawnService('gateway', 'bash', ['-c', `TRADING_MODE=${mode} ~/ibc/gatewaystartmacos.sh -inline`]);

    await new Promise((r) => setTimeout(r, 5_000));

    if (mode !== 'paper' && mode !== 'live') {
      throw new Error(`Invalid IBKR mode: ${JSON.stringify(mode)}. Must be 'paper' or 'live'.`);
    }
    const gwPort = mode === 'paper' ? '4002' : '4001';
    log('orch', `Starting IBKR Sidecar (${mode} mode, gateway port ${gwPort})...`);
    spawnService('sidecar', 'bash', [resolve(ROOT, 'sidecar/scripts/start-sidecar.sh')], {
      env: { IBKR_GATEWAY_PORT: gwPort, LOG_DIR: PATHS.logs },
    });

    const ready = await waitForHealth('sidecar', sidecarStatusUrl, {
      check: (b: unknown) => {
        const body = b as { connected?: boolean; accountId?: string };
        if (body.connected !== true) return false;
        if (expectedAccountId && body.accountId !== expectedAccountId) {
          log('orch', `SAFETY: sidecar connected to wrong account (got=${body.accountId}, expected=${expectedAccountId})`);
          return false;
        }
        return true;
      },
      timeoutMs: 30_000,
      intervalMs: 2_000,
    });

    log('orch', ready ? 'Sidecar connected to IB Gateway' : 'Sidecar failed to connect — will retry');
  };

  await startGatewayAndSidecar();

  // Monitor loop: check every 30s, restart on disconnect. Retries forever —
  // a silent give-up after N attempts is worse than ongoing log noise.
  const monitor = async () => {
    while (!shuttingDown) {
      await new Promise((r) => setTimeout(r, 30_000));
      if (shuttingDown) break;

      if (!(await isSidecarConnected())) {
        log('orch', `Sidecar lost connection — restarting in ${SIDECAR_RESTART_DELAY_MS / 1000}s`);
        await new Promise((r) => setTimeout(r, SIDECAR_RESTART_DELAY_MS));
        if (!shuttingDown) await startGatewayAndSidecar();
      }
    }
  };

  monitor().catch((err) => {
    if (!shuttingDown) log('orch', `Sidecar monitor error: ${err}`);
  });
}

// ─── Kill existing processes ─────────────────────────

function killPid(pid: number, label: string): void {
  try {
    process.kill(pid, 0); // check alive
    log('orch', `Killing existing ${label} (PID ${pid})`);
    process.kill(pid, 'SIGTERM');
  } catch {
    // not running
  }
}

function killOnPort(port: number, label: string): void {
  try {
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf-8' }).trim();
    for (const line of out.split('\n')) {
      const pid = parseInt(line, 10);
      if (!isNaN(pid) && pid !== process.pid) killPid(pid, `${label} :${port}`);
    }
  } catch {
    // nothing on that port
  }
}

function killExisting(): void {
  log('orch', 'Killing existing processes...');

  // Backend via pidlock
  const lockPath = resolve(ROOT, 'data', 'backend.lock');
  try {
    const pid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    if (!isNaN(pid)) {
      killPid(pid, 'backend');
      try { unlinkSync(lockPath); } catch {}
    }
  } catch {
    // no lock file
  }

  // Kill by port
  killOnPort(3791, 'local-api');
  killOnPort(3000, 'web');
  killOnPort(8090, 'sidecar');

  // Brief pause so ports are released
  execSync('sleep 1');
}

// ─── Main ────────────────────────────────────────────

async function main(): Promise<void> {
  console.log();
  log('orch', '='.repeat(50));
  log('orch', '  DEV STARTUP ORCHESTRATOR');
  log('orch', '='.repeat(50));
  console.log();

  killExisting();
  pruneOldLogs(LOG_RETENTION_DAYS);
  startBatteryMonitor();

  const channels = await detectChannels();

  if (channels.channelSummary.length > 0) {
    log('orch', `Channels: ${channels.channelSummary.join(', ')}`);
  } else {
    log('orch', 'No runtime channels configured');
  }
  if (NO_BACKEND) log('orch', 'Flag: --no-backend (skipping backend)');
  if (NO_IBKR) log('orch', 'Flag: --no-ibkr (skipping gateway/sidecar)');
  console.log();

  const needsIbkr = channels.hasIbkr && !NO_IBKR && !NO_BACKEND;
  const sidecarBase = channels.sidecarUrl;

  // ── Step 1: Local API (start immediately) ──

  log('orch', 'Starting local-api...');
  spawnService('api', 'npx', ['tsx', 'watch', 'src/local-api/server.ts'], {
    env: { LOG_PROCESS_NAME: 'api' },
  });

  await waitForHealth('local-api', 'http://localhost:3791/health', {
    timeoutMs: 15_000,
  });

  // ── Step 2: Web (Vite dev server, start immediately) ──

  log('orch', 'Starting web...');
  spawnService('web', 'npm', ['run', 'dev'], { cwd: resolve(ROOT, 'web') });

  // ── Step 3: Backend (if not skipped) — supervised with auto-restart ──

  if (!NO_BACKEND) {
    // Don't await — runs in background with auto-restart on crash/OOM
    superviseBackend().catch((err) => {
      log('orch', `Backend supervisor failed: ${err}`);
    });
  }

  // ── Step 4: IBKR Gateway + Sidecar (background, never blocks) ──

  if (needsIbkr) {
    // Don't await — runs entirely in the background with auto-restart
    superviseSidecar(sidecarBase, channels.ibkrMode, channels.ibkrAccountId).catch((err) => {
      log('orch', `Sidecar supervisor failed: ${err}`);
    });
  }

  // ── Ready ──

  console.log();
  log('orch', '='.repeat(50));
  log('orch', '  All services started');
  log('orch', '');
  log('orch', '  Web:       http://localhost:3000');
  log('orch', '  API:       http://localhost:3791');
  if (needsIbkr) {
    log('orch', `  Sidecar:   ${sidecarBase} (starting in background)`);
  }
  if (!NO_BACKEND) {
    log('orch', '  Backend:   running');
  }
  log('orch', '');
  log('orch', '  Press Ctrl+C to stop all services');
  log('orch', '='.repeat(50));
  console.log();
}

main().catch((err) => {
  console.error('Orchestrator failed:', err);
  shutdown();
});
