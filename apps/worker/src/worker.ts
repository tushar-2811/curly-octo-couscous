import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger, resolveLogFormat, startTelemetry, stopTelemetry } from '@aiw/logger';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { createActivities } from './activities';
import { loadWorkerConfig } from './config';
import { ActivityLoggingInterceptor, createTemporalLogger } from './logging';

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

/** In production the workflows are pre-bundled at build time; in dev Temporal bundles the source. */
function workflowSource(): { workflowBundle: { codePath: string } } | { workflowsPath: string } {
  const bundlePath = fileURLToPath(new URL('../workflow-bundle.js', import.meta.url));
  if (existsSync(bundlePath)) return { workflowBundle: { codePath: bundlePath } };
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

const connection = await connect();
const worker = await Worker.create({
  connection,
  namespace: config.TEMPORAL_NAMESPACE,
  taskQueue: config.TEMPORAL_TASK_QUEUE,
  ...workflowSource(),
  activities: createActivities({ logger }),
  interceptors: { activity: [() => ({ inbound: new ActivityLoggingInterceptor(logger) })] },
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
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
  await connection.close();
  await stopTelemetry();
}
