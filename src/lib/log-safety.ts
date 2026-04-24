/**
 * Process-level error handlers that log via the structured logger before exit.
 *
 * Wires `uncaughtException` and `unhandledRejection` into the root logger so
 * nothing dies silently — the JSON file has the full error on the way out.
 */

import { createLogger, flushLogs } from './logger.js';

const log = createLogger('process');

type InstallOptions = {
  onFatal?: (kind: 'uncaughtException' | 'unhandledRejection', err: unknown) => void | Promise<void>;
  exitOnUncaught?: boolean;
};

let installed = false;

export function installProcessErrorHandlers(opts: InstallOptions = {}): void {
  if (installed) return;
  installed = true;

  const exitOnUncaught = opts.exitOnUncaught ?? true;

  const finalize = async (kind: 'uncaughtException' | 'unhandledRejection', err: unknown): Promise<void> => {
    try {
      await opts.onFatal?.(kind, err);
    } catch (cleanupErr) {
      log.error({ err: cleanupErr }, 'fatal cleanup handler threw');
    }
    flushLogs();
    await new Promise((r) => setTimeout(r, 50));
    if (exitOnUncaught) process.exit(1);
  };

  process.on('uncaughtException', (err) => {
    log.error({ err }, 'uncaughtException');
    void finalize('uncaughtException', err);
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error({ err }, 'unhandledRejection');
    void finalize('unhandledRejection', reason);
  });
}
