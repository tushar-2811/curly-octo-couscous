import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { withLogContext } from '@aiw/logger';
import type { FastifyInstance } from 'fastify';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Use the caller's X-Request-Id when it is a safe value (the dashboard sends one so a
 * browser action and its API logs share an id); otherwise generate a new one.
 */
export function genRequestId(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  const incoming = Array.isArray(header) ? header[0] : header;
  return incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * Per-request logging:
 * - every log line written while handling the request carries request_id
 * - the response echoes X-Request-Id
 * - one "request completed" line per request with method, route, status and duration
 *   (warn for 4xx, error for 5xx; health probes only at debug to keep logs readable)
 */
export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    withLogContext({ request_id: request.id }, () => done());
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const fields = {
      method: request.method,
      route,
      url: request.url,
      status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
    };
    const isProbe = route === '/healthz' || route === '/readyz';
    if (reply.statusCode >= 500) request.log.error(fields, 'request completed');
    else if (reply.statusCode >= 400) request.log.warn(fields, 'request completed');
    else if (isProbe) request.log.debug(fields, 'request completed');
    else request.log.info(fields, 'request completed');
    done();
  });
}
