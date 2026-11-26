import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Logger } from '@aiw/logger';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerSession, type AuthDeps } from './auth';
import { AppError, errorHandler, notFoundHandler } from './errors';
import { genRequestId, registerRequestContext } from './request-context';
import { registerAuthRoutes } from './routes/auth';
import { registerClientLogRoutes } from './routes/client-logs';
import { registerHealthRoutes, type ReadinessChecks } from './routes/health';
import { registerOrganizationRoutes } from './routes/organizations';
import { registerEmployeeRoutes } from './routes/employees';
import { registerIdentityRoutes } from './routes/identities';
import { registerStructureRoutes } from './routes/structure';

export interface BuildAppOptions {
  logger: Logger;
  meta: { service: string; version: string; env: string };
  readinessChecks: ReadinessChecks;
  clientLogRateLimit?: number;
  /** Sessions and the authenticated API. Omitted in tests that only need health routes. */
  auth?: AuthDeps & { devLogin: boolean };
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
  await app.register(cookie);

  // CSRF guard: state-changing requests must be JSON. Browsers cannot send a cross-site
  // JSON POST without a CORS preflight, and session cookies are SameSite=Lax.
  app.addHook('onRequest', async (request) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const hasBody = Number(request.headers['content-length'] ?? 0) > 0;
    if (hasBody && !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
      throw new AppError(
        415,
        'unsupported_media_type',
        'Send JSON',
        'Use Content-Type: application/json.',
      );
    }
  });

  if (options.auth) registerSession(app, options.auth);

  registerHealthRoutes(app, options.meta, options.readinessChecks);
  registerClientLogRoutes(app, options.clientLogRateLimit ?? 120);
  if (options.auth) {
    registerAuthRoutes(app, options.auth, { devLogin: options.auth.devLogin });
    registerOrganizationRoutes(app, options.auth);
    registerStructureRoutes(app, options.auth);
    registerEmployeeRoutes(app, options.auth);
    registerIdentityRoutes(app, options.auth);
  }

  return app;
}
