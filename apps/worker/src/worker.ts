import { existsSync } from 'node:fs';
import { createDb } from '@aiw/db';
import { createModels } from '@aiw/engine';
import { fileURLToPath } from 'node:url';
import { createLogger, resolveLogFormat, startTelemetry, stopTelemetry } from '@aiw/logger';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { createActivities } from './activities';
import { loadWorkerConfig } from './config';
import { ActivityLoggingInterceptor, createTemporalLogger } from './logging';
import { sweepMessages } from './sweep';

const config = loadWorkerConfig();
const logger = createLogger({
  service: 'worker',
  version: config.SERVICE_VERSION,
  env: config.APP_ENV,
  level: config.LOG_LEVEL,
  format: resolveLogFormat(config.LOG_FORMAT, config.NODE_ENV),
});

startTelemetry({
  service: 'worker',
  version: config.SERVICE_VERSION,
  otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
});
process.on('unhandledRejection', (reason) =>
  logger.error({ err: reason }, 'unhandled promise rejection'),
);

Runtime.install({
  logger: createTemporalLogger(logger, config.LOG_LEVEL === 'debug' ? 'DEBUG' : 'INFO'),
});

/**
 * In production the workflows are pre-bundled at build time. Everywhere else Temporal
 * bundles the source, so a bundle left over from `pnpm build` can never hide new or
 * changed workflows in development.
 */
function workflowSource(): { workflowBundle: { codePath: string } } | { workflowsPath: string } {
  const bundlePath = fileURLToPath(new URL('../workflow-bundle.js', import.meta.url));
  if (config.NODE_ENV === 'production') {
    if (!existsSync(bundlePath)) {
      logger.fatal({ bundle_path: bundlePath }, 'workflow bundle missing; run the worker build');
      process.exit(1);
    }
    return { workflowBundle: { codePath: bundlePath } };
  }
  return { workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)) };
}

async function connect(): Promise<NativeConnection> {
  for (let attempt = 1; ; attempt++) {
    try {
      const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
      logger.info({ address: config.TEMPORAL_ADDRESS }, 'connected to Temporal');
      return connection;
    } catch (err) {
      const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      logger.warn(
        { err, attempt, retry_in_ms: delayMs, address: config.TEMPORAL_ADDRESS },
        'cannot reach Temporal; retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const db = createDb({
  connectionString: config.DATABASE_URL,
  poolMax: config.DATABASE_POOL_MAX,
  logger,
});

const models = createModels(config);
if (models.llm) logger.info({ model: models.llm.model }, 'message classifier enabled');
else logger.warn('message classifier is off: OPENAI_API_KEY is not set');
if (models.embedder) logger.info({ model: models.embedder.model }, 'memory embeddings enabled');
else logger.warn('memory embeddings are off: VOYAGE_API_KEY is not set');

const connection = await connect();
const worker = await Worker.create({
  connection,
  namespace: config.TEMPORAL_NAMESPACE,
  taskQueue: config.TEMPORAL_TASK_QUEUE,
  ...workflowSource(),
  activities: createActivities({ logger, db, ...models }),
  interceptors: { activity: [() => ({ inbound: new ActivityLoggingInterceptor(logger) })] },
});

// The sweep starts workflows, so it needs a client connection as well as the worker's.
const clientConnection = await Connection.connect({ address: config.TEMPORAL_ADDRESS });
const client = new Client({ connection: clientConnection, namespace: config.TEMPORAL_NAMESPACE });
let sweeping = false;
const sweep = async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await sweepMessages({ db, client, taskQueue: config.TEMPORAL_TASK_QUEUE, logger });
  } catch (err) {
    logger.error({ err }, 'message sweep failed');
  } finally {
    sweeping = false;
  }
};
const sweepTimer = setInterval(() => void sweep(), config.MESSAGE_SWEEP_SECONDS * 1000);
setTimeout(() => void sweep(), 5000);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    clearInterval(sweepTimer);
    logger.info({ signal }, 'shutting down worker; finishing in-flight tasks');
    worker.shutdown();
  });
}

logger.info(
  { task_queue: config.TEMPORAL_TASK_QUEUE, namespace: config.TEMPORAL_NAMESPACE },
  'worker started',
);
try {
  await worker.run();
  logger.info('worker stopped');
} catch (err) {
  logger.fatal({ err }, 'worker crashed');
  process.exitCode = 1;
} finally {
  clearInterval(sweepTimer);
  await clientConnection.close();
  await connection.close();
  await db.destroy();
  await stopTelemetry();
}
