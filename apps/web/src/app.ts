import rateLimit from '@fastify/rate-limit';
import type { Logger } from '@aiw/logger';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { errorHandler, notFoundHandler } from './errors';
import { genRequestId, registerRequestContext } from './request-context';
import { registerClientLogRoutes } from './routes/client-logs';
import { registerHealthRoutes, type ReadinessChecks } from './routes/health';

export interface BuildAppOptions {
  logger: Logger;
  meta: { service: string; version: string; env: string };
  readinessChecks: ReadinessChecks;
  clientLogRateLimit?: number;
}

/** Build the web app without listening, so tests can drive it with `app.inject`. */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // pino's Logger type and Fastify's logger type differ only in typing; the instance is the same.
    loggerInstance: options.logger as unknown as FastifyBaseLogger,
    // Request logging is done by our own hook (request-context.ts) with richer fields.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'request_id',
    }),
    genReqId: genRequestId,
    trustProxy: true,
  });

  registerRequestContext(app);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(rateLimit, { global: false });

  registerHealthRoutes(app, options.meta, options.readinessChecks);
  registerClientLogRoutes(app, options.clientLogRateLimit ?? 120);

  return app;
}
