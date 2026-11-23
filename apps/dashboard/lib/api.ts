import 'server-only';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { ApiError, toApiError } from './api-error';
import { serverLog } from './server-log';
import type { Me } from './types';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const TIMEOUT_MS = 8000;

/**
 * Server-side fetch to the web API, forwarding the user's session cookie. Each call gets a
 * request id that is sent as X-Request-Id, logged here, and attached to any ApiError, so
 * a failure on screen can be traced to the exact API log lines. Network errors and
 * timeouts become ApiError with status 0 (code "api_unreachable" or "api_timeout").
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const requestId = randomUUID();
  const startedAt = performance.now();
  const cookieHeader = (await cookies()).toString();
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'x-request-id': requestId,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    const code = timedOut ? 'api_timeout' : 'api_unreachable';
    serverLog('error', 'api call failed before a response', {
      request_id: requestId,
      path,
      code,
      err,
    });
    throw new ApiError(
      0,
      code,
      timedOut ? 'The API took too long to respond' : "Can't reach the API",
      timedOut
        ? `No response within ${TIMEOUT_MS / 1000} seconds.`
        : 'The service may be down or restarting.',
      requestId,
    );
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = toApiError(response.status, body, requestId);
    // 401/404 are normal outcomes (signed out, gone) rather than problems.
    const level =
      response.status >= 500
        ? 'error'
        : response.status === 401 || response.status === 404
          ? 'info'
          : 'warn';
    serverLog(level, 'api call returned an error', {
      request_id: error.requestId,
      path,
      status: response.status,
      code: error.code,
      duration_ms: durationMs,
    });
    throw error;
  }
  serverLog('debug', 'api call succeeded', {
    request_id: requestId,
    path,
    status: response.status,
    duration_ms: durationMs,
  });
  return body as T;
}

/**
 * The signed-in person, their member record and organization. Memoized per request.
 * Signed out → redirect to sign-in. Other API errors propagate to the caller.
 */
export const getMe = cache(async (): Promise<Me> => {
  try {
    return await apiFetch<Me>('/v1/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/sign-in');
    throw err;
  }
});
