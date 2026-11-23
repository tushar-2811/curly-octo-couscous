import { trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getLogContext } from './context';

export type { Logger } from 'pino';

/**
 * Paths whose values must never reach a log line. Matching is by key anywhere in the
 * first two levels of a logged object, plus common HTTP header locations.
 */
export const REDACT_PATHS = [
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'authorization',
  'cookie',
  'clientSecret',
  '*.password',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
  '*.clientSecret',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

export interface CreateLoggerOptions {
  /** Process or component name, for example "web", "worker", "egress". */
  service: string;
  version?: string;
  env?: string;
  level?: LoggerOptions['level'];
  /** "pretty" prints readable lines for local dev; "json" is the default elsewhere. */
  format?: 'pretty' | 'json';
  /** Override the output stream (used by tests). */
  destination?: DestinationStream;
}

/**
 * Create the process logger. Every line includes:
 * - service, version, env (from `base`)
 * - the current LogContext (request_id, org_id, task_id, ...)
 * - trace_id and span_id of the active OpenTelemetry span, when there is one
 * Errors logged under the `err` key are serialized with type, message, stack and cause.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const format = options.format ?? 'json';
  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: {
      service: options.service,
      version: options.version ?? '0.0.0-local',
      env: options.env ?? 'local',
    },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      err: pino.stdSerializers.errWithCause,
      error: pino.stdSerializers.errWithCause,
    },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    mixin() {
      const span = trace.getActiveSpan();
      const spanContext = span?.spanContext();
      return {
        ...getLogContext(),
        ...(spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {}),
      };
    },
  };

  if (options.destination) return pino(pinoOptions, options.destination);

  if (format === 'pretty') {
    return pino({
      ...pinoOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,version,env',
          messageKey: 'msg',
        },
      },
    });
  }

  return pino(pinoOptions);
}

/** Pick the log format: explicit setting first, otherwise pretty only for local development. */
export function resolveLogFormat(
  explicit: 'pretty' | 'json' | undefined,
  nodeEnv: string,
): 'pretty' | 'json' {
  if (explicit) return explicit;
  return nodeEnv === 'development' ? 'pretty' : 'json';
}
