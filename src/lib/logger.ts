import { formatLogTimestampET } from './et-logging.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function createLogger(tag: string): Logger {
  return {
    debug: (...args) => {
      if (LEVELS[currentLevel] <= LEVELS.debug) {
        console.log(`[debug] [${formatLogTimestampET(new Date())}] [${tag}]`, ...args);
      }
    },
    info: (...args) => {
      if (LEVELS[currentLevel] <= LEVELS.info) {
        console.log(`[info] [${formatLogTimestampET(new Date())}] [${tag}]`, ...args);
      }
    },
    warn: (...args) => {
      if (LEVELS[currentLevel] <= LEVELS.warn) {
        console.warn(`[warn] [${formatLogTimestampET(new Date())}] [${tag}]`, ...args);
      }
    },
    error: (...args) => {
      if (LEVELS[currentLevel] <= LEVELS.error) {
        console.error(`[error] [${formatLogTimestampET(new Date())}] [${tag}]`, ...args);
      }
    },
  };
}
