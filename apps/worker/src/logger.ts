/** Minimal structured JSON logger (CloudWatch-friendly). Never pass tokens or secrets in `meta`. */
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = (process.env.LOG_LEVEL as Level) || 'info';

export function setLogLevel(level: Level) {
  threshold = level;
}

function log(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (order[level] < order[threshold]) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: 'worker', msg, ...meta });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.info(line);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
