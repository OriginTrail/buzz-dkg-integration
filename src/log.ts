/** Minimal structured logger; secrets are the caller's job to keep out. */
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold: number = order[(process.env.BDI_LOG_LEVEL as Level) ?? 'info'] ?? 20;

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, message, ...fields };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => log('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => log('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => log('error', m, f),
};
