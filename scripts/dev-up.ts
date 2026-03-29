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
import { readFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendSystemAlert } from '../src/lib/alert.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

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
  sidecarUrl: string;
  channelSummary: string[];
};

async function detectChannels(): Promise<ChannelInfo> {
  // Load secrets into process.env exactly like the app does
  const { loadSecrets } = await import('../src/lib/secrets/index.js');
  await loadSecrets();

  // Now read channel definitions (they read from process.env)
  const { getRuntimeChannelDefinitions } = await import('../src/lib/runtime-channels.js');

  let defs: { brokerName: string; label: string; mode?: string; sidecarUrl?: string }[];
  try {
    defs = getRuntimeChannelDefinitions();
  } catch {
    // No channels configured — that's okay for --no-backend mode
    defs = [];
  }

  const ibkrDefs = defs.filter((d) => d.brokerName === 'ibkr');
  const sidecarUrl = ibkrDefs[0]?.sidecarUrl ?? 'http://localhost:8090/api';
  const ibkrMode = (ibkrDefs[0]?.mode === 'paper' ? 'paper' : 'live') as 'live' | 'paper';

  return {
    hasIbkr: ibkrDefs.length > 0,
    ibkrMode,
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

  const startBackend = (): Promise<number | null> => {
    return new Promise((resolve) => {
      const child = spawnService('backend', 'npx', ['tsx', 'src/index.ts']);
      child.on('exit', (code) => resolve(code));
    });
  };

  while (!shuttingDown) {
    const startTime = Date.now();
    log('orch', `Starting backend (attempt ${restartCount + 1})...`);

    const exitCode = await startBackend();
    if (shuttingDown) break;

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
    const reason = exitCode === 137 ? 'OOM killed' : `exit code ${exitCode}`;
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

const SIDECAR_MAX_RESTARTS = 5;
const SIDECAR_RESTART_DELAY_MS = 10_000;

/**
 * Manages the IBKR gateway + sidecar lifecycle with automatic restarts.
 * Runs in the background — never blocks other services.
 */
async function superviseSidecar(sidecarBase: string, mode: 'live' | 'paper'): Promise<void> {
  const sidecarStatusUrl = `${sidecarBase}/status`;
  let restartCount = 0;

  const isSidecarConnected = async (): Promise<boolean> => {
    try {
      const res = await fetch(sidecarStatusUrl, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return false;
      const body = (await res.json()) as { connected?: boolean };
      return body.connected === true;
    } catch {
      return false;
    }
  };

  const startGatewayAndSidecar = async (): Promise<void> => {
    // Kill existing sidecar/gateway children before restart
    for (const child of children) {
      if (['gateway', 'sidecar'].includes(child.name) && child.proc.exitCode === null && !child.proc.killed) {
        log('orch', `Stopping old ${child.name} (PID ${child.proc.pid})`);
        child.proc.kill('SIGTERM');
      }
    }

    log('orch', 'Starting IB Gateway...');
    spawnService('gateway', 'bash', ['-c', '~/ibc/gatewaystartmacos.sh -inline']);

    // Give gateway time to initialize
    await new Promise((r) => setTimeout(r, 5_000));

    const gwPort = mode === 'paper' ? '4002' : '4001';
    log('orch', `Starting IBKR Sidecar (${mode} mode, gateway port ${gwPort})...`);
    spawnService('sidecar', 'bash', [resolve(ROOT, 'sidecar/scripts/start-sidecar.sh')], {
      env: { IBKR_GATEWAY_PORT: gwPort },
    });

    // Wait up to 30s for sidecar to connect
    const ready = await waitForHealth('sidecar', sidecarStatusUrl, {
      check: (b: unknown) => (b as { connected?: boolean }).connected === true,
      timeoutMs: 30_000,
      intervalMs: 2_000,
    });

    if (ready) {
      restartCount = 0; // Reset on success
      log('orch', 'Sidecar connected to IB Gateway');
    } else {
      log('orch', `Sidecar failed to connect (attempt ${restartCount + 1}/${SIDECAR_MAX_RESTARTS})`);
    }
  };

  // Check if already running
  if (await isSidecarConnected()) {
    log('orch', 'Sidecar already running and connected — skipping start');
    // Still monitor it below
  } else {
    await startGatewayAndSidecar();
  }

  // Monitor loop: check every 30s, restart if needed
  const monitor = async () => {
    while (!shuttingDown) {
      await new Promise((r) => setTimeout(r, 30_000));
      if (shuttingDown) break;

      if (!(await isSidecarConnected())) {
        restartCount++;
        if (restartCount > SIDECAR_MAX_RESTARTS) {
          log('orch', `Sidecar failed ${SIDECAR_MAX_RESTARTS} times — giving up. Manual intervention required.`);
          return;
        }
        log('orch', `Sidecar lost connection — restarting in ${SIDECAR_RESTART_DELAY_MS / 1000}s (attempt ${restartCount}/${SIDECAR_MAX_RESTARTS})`);
        await new Promise((r) => setTimeout(r, SIDECAR_RESTART_DELAY_MS));
        if (!shuttingDown) await startGatewayAndSidecar();
      }
    }
  };

  // Fire and forget — monitor runs in background
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
  spawnService('api', 'npx', ['tsx', 'watch', 'src/local-api/server.ts']);

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
    superviseSidecar(sidecarBase, channels.ibkrMode).catch((err) => {
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
