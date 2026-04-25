/**
 * Resume CLI — clears the kill switch after explicit confirmation.
 *
 * Usage:
 *   pnpm resume           # prompts for confirmation
 *   pnpm resume --yes     # skip prompt (for automation)
 */

import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { createInterface } from 'node:readline';
import { isHalted, readHaltState, clearHalt } from '../lib/halt-state.js';
import { sendSystemAlert } from '../lib/alert.js';

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

async function main() {
  const skipPrompt = process.argv.includes('--yes');

  if (!isHalted()) {
    console.log('[resume] Trading is not halted. Nothing to do.');
    process.exit(0);
  }

  const state = readHaltState();
  console.log('\n[resume] Current halt state:');
  console.log(`  Halted at:    ${state?.haltedAt ?? 'unknown'}`);
  console.log(`  Reason:       ${state?.reason ?? 'unknown'}`);
  console.log(`  Triggered by: ${state?.triggeredBy ?? 'unknown'}\n`);

  if (!skipPrompt) {
    const ok = await confirm('Clear kill switch and resume trading? [y/N] ');
    if (!ok) {
      console.log('[resume] Aborted. Trading remains halted.');
      process.exit(0);
    }
  }

  clearHalt();
  console.log('[resume] Kill switch cleared. Trading will resume on next signal.\n');

  await sendSystemAlert({
    title: 'Trading Resumed',
    message: `Kill switch cleared via CLI. Previous halt reason: ${state?.reason ?? 'unknown'}`,
    severity: 'info',
  });

  process.exit(0);
}

main().catch((err) => {
  console.error('[resume] Fatal error:', err);
  process.exit(1);
});
