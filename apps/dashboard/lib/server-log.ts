import 'server-only';

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured JSON logs for the dashboard's server side (server components, route
 * handlers), in the same shape as the backend logs so one query covers both.
 */
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = ORDER[(process.env.LOG_LEVEL as Level | undefined) ?? 'info'] ?? ORDER.info;

export function serverLog(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < minLevel) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    service: 'dashboard',
    env: process.env.APP_ENV ?? 'local',
    msg,
    ...serializeErrors(fields),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function serializeErrors(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] =
      value instanceof Error
        ? { type: value.name, message: value.message, stack: value.stack, cause: value.cause }
        : value;
  }
  return out;
}
