import { resolve } from 'node:path';

export const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

export function projectPath(...parts: string[]): string {
  return resolve(PROJECT_ROOT, ...parts);
}

export const PATHS = {
  data: projectPath('data'),
  logs: projectPath('.logs'),
  db: projectPath('data', 'trade-follower.db'),
  lockFile: projectPath('data', 'backend.lock'),
  envFile: projectPath('.env'),
  browserSession: projectPath('data', 'browser-session'),
  tickCacheDb: projectPath('data', 'tick-cache.db'),
} as const;
