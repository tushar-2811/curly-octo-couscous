import { createDb, pingDb } from '@aiw/db';
import { createLogger, resolveLogFormat, startTelemetry, stopTelemetry } from '@aiw/logger';
import { SecretBox } from '@aiw/platform';
import { buildApp } from './app';
import { loadWebConfig } from './config';
import { HttpGoogleOAuth } from './google-oauth';
import { TemporalOnboardingSignals } from './onboarding';
import { SessionCodec } from './session';

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
  auth: {
    db,
    codec: new SessionCodec(config.SESSION_SECRET, config.SESSION_TTL_HOURS),
    // Local dev runs over http; everywhere else cookies are HTTPS-only.
    secureCookies: config.APP_ENV !== 'local',
    devLogin: config.AUTH_DEV_LOGIN,
    ...(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.TOKEN_ENCRYPTION_KEY
      ? {
          google: {
            oauth: new HttpGoogleOAuth(
              config.GOOGLE_CLIENT_ID,
              config.GOOGLE_CLIENT_SECRET,
              `${config.DASHBOARD_URL}/api/v1/oauth/google/callback`,
            ),
            secrets: new SecretBox(config.TOKEN_ENCRYPTION_KEY),
          },
        }
      : {}),
    onboarding: new TemporalOnboardingSignals(
      {
        address: config.TEMPORAL_ADDRESS,
        namespace: config.TEMPORAL_NAMESPACE,
        taskQueue: config.TEMPORAL_TASK_QUEUE,
      },
      logger,
    ),
  },
});
if (config.GOOGLE_CLIENT_ID) {
  logger.info(
    { redirect_uri: `${config.DASHBOARD_URL}/api/v1/oauth/google/callback` },
    'google account linking enabled',
  );
} else {
  logger.warn('google account linking is off: GOOGLE_CLIENT_ID is not set');
}
if (config.AUTH_DEV_LOGIN) logger.warn('development sign-in is enabled (local only)');

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
