import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { WorkforceError } from '@aiw/workforce';
import { ZodError } from 'zod';

/**
 * An expected failure with a stable, machine-readable code. Throw it from a route; the
 * error handler turns it into an RFC 7807 problem response.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly title: string,
    public readonly detail?: string,
    public readonly extras?: Record<string, unknown>,
  ) {
    super(detail ?? title);
    this.name = 'AppError';
  }
}

const WORKFORCE_STATUS: Record<WorkforceError['code'], number> = {
  already_member: 409,
  domain_taken: 409,
  domain_not_allowed: 422,
  not_found: 404,
  forbidden: 403,
};

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance: string;
  request_id: string;
  [key: string]: unknown;
}

function problem(
  request: FastifyRequest,
  status: number,
  code: string,
  title: string,
  detail?: string,
  extras?: Record<string, unknown>,
): Problem {
  return {
    type: `urn:aiw:error:${code}`,
    title,
    status,
    code,
    ...(detail ? { detail } : {}),
    instance: request.url,
    request_id: request.id,
    ...extras,
  };
}

function send(reply: FastifyReply, body: Problem): FastifyReply {
  return reply.status(body.status).type('application/problem+json').send(body);
}

/**
 * Central error handler. Expected errors (validation, AppError, 4xx from Fastify) are
 * logged as warnings with their code; anything else is a 500, logged with the full error
 * and stack, while the client only gets a generic message plus the request id to quote.
 */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof ZodError) {
    const errors = error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    request.log.warn({ code: 'validation_failed', errors }, 'request validation failed');
    return send(
      reply,
      problem(request, 400, 'validation_failed', 'Request validation failed', undefined, {
        errors,
      }),
    );
  }

  if (error instanceof WorkforceError) {
    const status = WORKFORCE_STATUS[error.code];
    const extras = error.field
      ? { errors: [{ path: error.field, message: error.message }] }
      : undefined;
    request.log.warn({ code: error.code, field: error.field }, error.message);
    return send(reply, problem(request, status, error.code, error.message, undefined, extras));
  }

  if (error instanceof AppError) {
    const log =
      error.status >= 500
        ? request.log.error.bind(request.log)
        : request.log.warn.bind(request.log);
    log({ err: error, code: error.code }, error.title);
    return send(
      reply,
      problem(request, error.status, error.code, error.title, error.detail, error.extras),
    );
  }

  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    const code =
      'code' in error && typeof error.code === 'string' ? error.code.toLowerCase() : 'bad_request';
    request.log.warn({ code, detail: error.message }, 'client error');
    return send(reply, problem(request, statusCode, code, error.message));
  }

  request.log.error({ err: error }, 'unhandled error');
  return send(
    reply,
    problem(
      request,
      500,
      'internal_error',
      'Something went wrong',
      'An unexpected error occurred. Quote the request id when reporting it.',
    ),
  );
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  request.log.warn({ code: 'not_found' }, 'route not found');
  return send(
    reply,
    problem(
      request,
      404,
      'not_found',
      'Not found',
      `No route for ${request.method} ${request.url}`,
    ),
  );
}
