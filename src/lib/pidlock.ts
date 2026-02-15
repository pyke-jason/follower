import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(lockPath: string): { acquired: boolean; existingPid?: number } {
  mkdirSync(dirname(lockPath), { recursive: true });

  try {
    const content = readFileSync(lockPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    if (!isNaN(pid) && isProcessAlive(pid)) {
      return { acquired: false, existingPid: pid };
    }
    console.log(`[pidlock] Cleaning stale lock (PID ${pid} no longer running)`);
  } catch {
    // No lock file or unreadable — proceed
  }

  writeFileSync(lockPath, String(process.pid), 'utf-8');
  return { acquired: true };
}

export function releaseLock(lockPath: string): void {
  try {
    const content = readFileSync(lockPath, 'utf-8').trim();
    if (content === String(process.pid)) {
      unlinkSync(lockPath);
    }
  } catch {
    // Already removed or unreadable — fine
  }
}
