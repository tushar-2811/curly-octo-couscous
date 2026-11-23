import { createDb, pingDb } from '@aiw/db';
import { createLogger, resolveLogFormat, startTelemetry, stopTelemetry } from '@aiw/logger';
import { buildApp } from './app';
import { loadWebConfig } from './config';

const config = loadWebConfig();
const logger = createLogger({
  service: 'web',
  version: config.SERVICE_VERSION,
  env: config.APP_ENV,
  level: config.LOG_LEVEL,
  format: resolveLogFormat(config.LOG_FORMAT, config.NODE_ENV),
});

startTelemetry({
  service: 'web',
  version: config.SERVICE_VERSION,
  otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
});

process.on('unhandledRejection', (reason) =>
  logger.error({ err: reason }, 'unhandled promise rejection'),
);
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception; exiting');
  process.exit(1);
});

const db = createDb({
  connectionString: config.DATABASE_URL,
  poolMax: config.DATABASE_POOL_MAX,
  logger,
});

const app = await buildApp({
  logger,
  meta: { service: 'web', version: config.SERVICE_VERSION, env: config.APP_ENV },
  readinessChecks: { database: () => pingDb(db) },
  clientLogRateLimit: config.CLIENT_LOG_RATE_LIMIT,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
    await db.destroy();
    await stopTelemetry();
    logger.info('shutdown complete');
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exitCode = 1;
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.WEB_HOST, port: config.WEB_PORT });
  logger.info({ host: config.WEB_HOST, port: config.WEB_PORT }, 'web listening');
} catch (err) {
  logger.fatal({ err }, 'web failed to start');
  process.exit(1);
}
