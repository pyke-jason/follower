/**
 * Rolling log file writer.
 *
 * Opens an append stream to `<dir>/<prefix>-YYYY-MM-DD.log` and transparently
 * rolls to a new file on UTC date change. Safe for concurrent writers within
 * a single process; cross-process appends rely on POSIX O_APPEND atomicity.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';

type RollingOptions = {
  dir: string;
  prefix: string;
};

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pathFor(dir: string, prefix: string, day: string): string {
  return resolve(dir, `${prefix}-${day}.log`);
}

export function createRollingFileStream(opts: RollingOptions): Writable {
  mkdirSync(opts.dir, { recursive: true });

  let currentDay = dayKey(new Date());
  let currentStream: WriteStream = createWriteStream(
    pathFor(opts.dir, opts.prefix, currentDay),
    { flags: 'a' },
  );

  currentStream.on('error', (err) => {
    process.stderr.write(`[log-rotation] write error: ${err.message}\n`);
  });

  const roll = (): void => {
    const day = dayKey(new Date());
    if (day === currentDay) return;
    const old = currentStream;
    currentDay = day;
    currentStream = createWriteStream(pathFor(opts.dir, opts.prefix, currentDay), { flags: 'a' });
    currentStream.on('error', (err) => {
      process.stderr.write(`[log-rotation] write error: ${err.message}\n`);
    });
    old.end();
  };

  return new Writable({
    write(chunk, _enc, cb) {
      roll();
      currentStream.write(chunk, cb);
    },
    final(cb) {
      currentStream.end(cb);
    },
  });
}
