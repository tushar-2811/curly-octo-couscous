import { createDb, pingDb } from '@aiw/db';
import { createLogger, resolveLogFormat, startTelemetry, stopTelemetry } from '@aiw/logger';
import { createModels } from '@aiw/engine';
import { SecretBox } from '@aiw/platform';
import { CHAT_SCOPES, GMAIL_SCOPES, IDENTITY_SCOPES } from '@aiw/workforce';
import { buildApp } from './app';
import { loadWebConfig } from './config';
import { HttpGoogleOAuth } from './google-oauth';
import { TemporalMessageDispatcher } from './messages';
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

const models = createModels(config);
const chatConfigured = Boolean(
  config.GOOGLE_CLOUD_PROJECT && config.CHAT_EVENTS_TOPIC && config.CHAT_EVENTS_SUBSCRIPTION,
);

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
            // Chat and Gmail share the Pub/Sub topic, so both are on when it is set.
            scopes: chatConfigured
              ? [...IDENTITY_SCOPES, ...CHAT_SCOPES, ...GMAIL_SCOPES]
              : IDENTITY_SCOPES,
          },
        }
      : {}),
    engine: {
      ...models,
      dispatcher: new TemporalMessageDispatcher(
        {
          address: config.TEMPORAL_ADDRESS,
          namespace: config.TEMPORAL_NAMESPACE,
          taskQueue: config.TEMPORAL_TASK_QUEUE,
        },
        logger,
      ),
      // Typed test messages are for trying the classifier before Chat and Gmail intake.
      allowTestMessages: config.APP_ENV === 'local' || config.APP_ENV === 'dev',
    },
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
if (config.OPENAI_API_KEY) {
  logger.info({ model: config.OPENAI_MODEL }, 'message classifier enabled');
} else {
  logger.warn('message classifier is off: OPENAI_API_KEY is not set');
}
if (config.VOYAGE_API_KEY) {
  logger.info({ model: config.VOYAGE_MODEL }, 'memory embeddings enabled');
} else {
  logger.warn('memory embeddings are off: VOYAGE_API_KEY is not set; searching by words only');
}
if (models.jira) logger.info({ site: models.jira.site }, 'jira reading enabled');
else logger.warn('jira is off: set JIRA_BASE_URL, ATLASSIAN_EMAIL and ATLASSIAN_ACCESS_TOKEN');
if (chatConfigured)
  logger.info(
    { project: config.GOOGLE_CLOUD_PROJECT },
    'google chat and gmail access requested at sign-in',
  );
else
  logger.warn(
    'google chat and gmail are off: set GOOGLE_CLOUD_PROJECT, CHAT_EVENTS_TOPIC and CHAT_EVENTS_SUBSCRIPTION',
  );
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
