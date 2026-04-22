import pino, { type Logger as PinoLogger, multistream, stdSerializers } from 'pino';
import { Writable } from 'node:stream';
import util from 'node:util';
import { z } from 'zod';
import { formatLogTimestampET } from './et-logging.js';
import { createRollingFileStream } from './log-rotation.js';
import { PATHS } from './paths.js';

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

const LEVEL_LABEL: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const PROCESS_NAME = process.env.LOG_PROCESS_NAME ?? 'app';
const initialLevel: LogLevel = LogLevelSchema.catch('info').parse(process.env.LOG_LEVEL);

function inspectArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  return util.inspect(v, { depth: 4, breakLength: 120 });
}

type PinoRecord = {
  level: number;
  time: number;
  tag?: string;
  msg?: string;
  err?: { type?: string; message?: string; stack?: string };
  [key: string]: unknown;
};

const INTERNAL_KEYS = new Set(['level', 'time', 'tag', 'msg', 'hostname', 'pid', 'proc', 'v', 'err']);

function renderPretty(rec: PinoRecord): string {
  const level = LEVEL_LABEL[rec.level] ?? 'info';
  const tag = rec.tag ?? '';
  const time = formatLogTimestampET(new Date(rec.time));

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!INTERNAL_KEYS.has(k)) extras[k] = v;
  }

  let extrasStr = '';
  if (Object.keys(extras).length > 0) {
    extrasStr = ' ' + util.inspect(extras, { depth: 4, breakLength: 120, colors: false });
  }

  let errStr = '';
  if (rec.err) {
    errStr = '\n' + (rec.err.stack ?? `${rec.err.type ?? 'Error'}: ${rec.err.message ?? ''}`);
  }

  return `[${level}] [${time}] [${tag}] ${rec.msg ?? ''}${extrasStr}${errStr}\n`;
}

const prettyStream = new Writable({
  write(chunk: Buffer, _enc, cb) {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let rendered: string;
      try {
        rendered = renderPretty(JSON.parse(line) as PinoRecord);
      } catch {
        rendered = line + '\n';
      }
      const level = (() => {
        try {
          return LEVEL_LABEL[(JSON.parse(line) as PinoRecord).level] ?? 'info';
        } catch {
          return 'info';
        }
      })();
      const sink = level === 'warn' || level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
      sink.write(rendered);
    }
    cb();
  },
});

const fileStream = createRollingFileStream({ dir: PATHS.logs, prefix: PROCESS_NAME });

const root: PinoLogger = pino(
  {
    level: initialLevel,
    base: { proc: PROCESS_NAME },
    serializers: { err: stdSerializers.err },
  },
  multistream([
    { stream: prettyStream, level: initialLevel },
    { stream: fileStream, level: 'debug' },
  ]),
);

export function setLogLevel(level: LogLevel): void {
  root.level = level;
}

export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  child: (bindings: Record<string, unknown>) => Logger;
};

type PinoMethod = 'debug' | 'info' | 'warn' | 'error';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error);
}

function emit(p: PinoLogger, method: PinoMethod, args: unknown[]): void {
  if (args.length === 0) {
    p[method]('');
    return;
  }

  const [first, ...rest] = args;

  if (isPlainObject(first)) {
    const errs = rest.filter((a): a is Error => a instanceof Error);
    const nonErrRest = rest.filter((a) => !(a instanceof Error));
    const bindings = errs.length > 0 ? { ...first, err: errs[0] } : first;
    p[method](bindings, nonErrRest.map(inspectArg).join(' '));
    return;
  }

  const errs = args.filter((a): a is Error => a instanceof Error);
  const nonErr = args.filter((a) => !(a instanceof Error));
  const msg = nonErr.map(inspectArg).join(' ');
  if (errs.length > 0) {
    p[method]({ err: errs[0] }, msg);
    return;
  }
  p[method](msg);
}

function wrap(p: PinoLogger): Logger {
  return {
    debug: (...args) => emit(p, 'debug', args),
    info: (...args) => emit(p, 'info', args),
    warn: (...args) => emit(p, 'warn', args),
    error: (...args) => emit(p, 'error', args),
    child: (bindings) => wrap(p.child(bindings)),
  };
}

export function createLogger(tag: string): Logger {
  return wrap(root.child({ tag }));
}

export function flushLogs(): void {
  fileStream.end();
}
