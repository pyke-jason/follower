import { statfs } from 'node:fs/promises';
import { PROJECT_ROOT } from './paths.js';

const MIN_FREE_GB = parseFloat(process.env.MIN_FREE_DISK_GB ?? '5');

export async function checkDiskSpace(): Promise<void> {
  const stats = await statfs(PROJECT_ROOT);
  const freeBytes = stats.bavail * stats.bsize;
  const freeGb = freeBytes / 1024 ** 3;

  if (freeBytes < MIN_FREE_GB * 1024 ** 3) {
    throw new Error(
      `Insufficient disk space: ${freeGb.toFixed(1)} GB free (${MIN_FREE_GB} GB required). ` +
        `Clear space before starting trade follower.`,
    );
  }

  console.log(`[disk] ${freeGb.toFixed(1)} GB free — OK`);
}
