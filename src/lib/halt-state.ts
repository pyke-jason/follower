import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { PROJECT_ROOT } from './paths.js';

const HALT_FILE = resolve(PROJECT_ROOT, 'data', 'trading.halt');

export type HaltState = {
  haltedAt: string;
  reason: string;
  triggeredBy: 'cli' | 'api' | 'system';
};

export function isHalted(): boolean {
  return existsSync(HALT_FILE);
}

export function readHaltState(): HaltState | null {
  if (!existsSync(HALT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(HALT_FILE, 'utf-8')) as HaltState;
  } catch {
    return { haltedAt: new Date().toISOString(), reason: 'unknown (file unreadable)', triggeredBy: 'system' };
  }
}

export function setHalt(reason: string, triggeredBy: HaltState['triggeredBy'] = 'system'): HaltState {
  const state: HaltState = { haltedAt: new Date().toISOString(), reason, triggeredBy };
  mkdirSync(dirname(HALT_FILE), { recursive: true });
  writeFileSync(HALT_FILE, JSON.stringify(state, null, 2), 'utf-8');
  return state;
}

export function clearHalt(): void {
  if (existsSync(HALT_FILE)) rmSync(HALT_FILE);
}
