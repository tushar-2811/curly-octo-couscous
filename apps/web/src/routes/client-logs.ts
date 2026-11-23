import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const clientEvent = z.object({
  level: z.enum(['error', 'warn', 'info']),
  message: z.string().min(1).max(2000),
  /** Next.js error digest, which links a client error to the server-side log line. */
  digest: z.string().max(200).optional(),
  stack: z.string().max(8000).optional(),
  route: z.string().max(500).optional(),
  url: z.string().max(2000).optional(),
  user_agent: z.string().max(500).optional(),
  /** The request id of the API call that failed, when the error came from one. */
  request_id: z.string().max(128).optional(),
  occurred_at: z.string().max(40).optional(),
  context: z
    .record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean()]))
    .refine((value) => Object.keys(value).length <= 20, 'At most 20 context keys')
    .optional(),
});

export const clientLogBody = z.object({
  events: z.array(clientEvent).min(1).max(20),
});

/**
 * POST /v1/client-logs: the dashboard reports browser-side errors and notable events here,
 * so they land in the same log stream as the server, tagged source=dashboard.
 */
export function registerClientLogRoutes(app: FastifyInstance, rateLimitPerMinute: number): void {
  app.post(
    '/v1/client-logs',
    {
      bodyLimit: 64 * 1024,
      config: { rateLimit: { max: rateLimitPerMinute, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { events } = clientLogBody.parse(request.body);
      for (const event of events) {
        const { level, message, ...fields } = event;
        request.log[level](
          { source: 'dashboard', client_request_id: fields.request_id, ...fields },
          message,
        );
      }
      return reply.status(202).send({ accepted: events.length });
    },
  );
}
