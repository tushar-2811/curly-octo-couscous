import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';

export type ReadinessChecks = Record<string, () => Promise<void>>;

/**
 * /healthz: the process is up (liveness; never touches dependencies).
 * /readyz: every dependency answers (readiness). A failing check returns 503 and names
 * which dependency failed, and the failure is logged with its error.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  meta: { service: string; version: string; env: string },
  checks: ReadinessChecks,
): void {
  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (request) => {
    const results: Record<string, 'ok' | 'failed'> = {};
    await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await check();
          results[name] = 'ok';
        } catch (err) {
          results[name] = 'failed';
          request.log.error({ err, dependency: name }, 'readiness check failed');
        }
      }),
    );
    const failed = Object.keys(results).filter((name) => results[name] === 'failed');
    if (failed.length > 0) {
      throw new AppError(
        503,
        'dependency_unavailable',
        'A dependency is unavailable',
        `Failed: ${failed.join(', ')}`,
        {
          checks: results,
        },
      );
    }
    return { status: 'ready', checks: results };
  });

  app.get('/v1/meta', () => meta);
}
