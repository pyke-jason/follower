export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

function ts(): string {
  const d = new Date();
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const sec = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${h}:${min}:${sec}.${ms}`;
}

export function createLogger(tag: string): Logger {
  return {
    debug: (...args) => { if (LEVELS[currentLevel] <= LEVELS.debug) console.log(`[debug] [${ts()}] [${tag}]`, ...args); },
    info: (...args) => { if (LEVELS[currentLevel] <= LEVELS.info) console.log(`[info] [${ts()}] [${tag}]`, ...args); },
    warn: (...args) => { if (LEVELS[currentLevel] <= LEVELS.warn) console.warn(`[warn] [${ts()}] [${tag}]`, ...args); },
    error: (...args) => { if (LEVELS[currentLevel] <= LEVELS.error) console.error(`[error] [${ts()}] [${tag}]`, ...args); },
  };
}
