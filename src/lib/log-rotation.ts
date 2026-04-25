/**
 * Rolling log file writer.
 *
 * Rolls to a new file at UTC midnight OR when the current file reaches
 * MAX_FILE_BYTES (default 100 MB), whichever comes first.
 *
 * File naming:
 *   date roll  → <prefix>-YYYY-MM-DD.log
 *   size roll  → <prefix>-YYYY-MM-DDTHH-MM-SS.log
 */

import { createWriteStream, mkdirSync, statSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

type RollingOptions = {
  dir: string;
  prefix: string;
};

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function tsKey(d: Date): string {
  // e.g. 2026-04-24T14-30-00
  return d.toISOString().slice(0, 19).replace('T', 'T').replace(/:/g, '-');
}

function pathFor(dir: string, prefix: string, key: string): string {
  return resolve(dir, `${prefix}-${key}.log`);
}

function existingSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

export function createRollingFileStream(opts: RollingOptions): Writable {
  mkdirSync(opts.dir, { recursive: true });

  let currentDay = dayKey(new Date());
  let currentPath = pathFor(opts.dir, opts.prefix, currentDay);
  let bytesWritten = existingSize(currentPath);
  let currentStream: WriteStream = createWriteStream(currentPath, { flags: 'a' });

  currentStream.on('error', (err) => {
    process.stderr.write(`[log-rotation] write error: ${err.message}\n`);
  });

  const openStream = (p: string): WriteStream => {
    const s = createWriteStream(p, { flags: 'a' });
    s.on('error', (err) => {
      process.stderr.write(`[log-rotation] write error: ${err.message}\n`);
    });
    return s;
  };

  const roll = (chunkSize: number): void => {
    const now = new Date();
    const day = dayKey(now);
    const dateChanged = day !== currentDay;
    const sizeExceeded = bytesWritten + chunkSize > MAX_FILE_BYTES;

    if (!dateChanged && !sizeExceeded) return;

    const old = currentStream;
    if (dateChanged) {
      currentDay = day;
      currentPath = pathFor(opts.dir, opts.prefix, currentDay);
    } else {
      // intra-day size roll — use timestamp to avoid collision
      currentPath = pathFor(opts.dir, opts.prefix, tsKey(now));
    }
    bytesWritten = existingSize(currentPath);
    currentStream = openStream(currentPath);
    old.end();
  };

  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      roll(chunk.length);
      bytesWritten += chunk.length;
      currentStream.write(chunk, cb);
    },
    final(cb) {
      currentStream.end(cb);
    },
  });
}
