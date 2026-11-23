'use client';

import { reportClientEvent } from './client-log';

/** A failed browser-side API call, with per-field messages for forms. */
export class ClientApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly title: string,
    public readonly detail: string | undefined,
    public readonly requestId: string,
    public readonly fieldErrors: Record<string, string>,
  ) {
    super(detail ?? title);
    this.name = 'ClientApiError';
  }
}

/**
 * Browser fetch to the API through the dashboard's /api/v1 proxy (same origin, so the
 * session cookie is sent). Sends X-Request-Id, turns problem responses into
 * ClientApiError with field errors, and reports unexpected failures to the server logs.
 */
export async function clientFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const requestId = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': requestId,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      credentials: 'same-origin',
    });
  } catch {
    reportClientEvent({
      level: 'warn',
      message: 'API request failed before a response',
      request_id: requestId,
      context: { path },
    });
    throw new ClientApiError(
      0,
      'network_error',
      "Can't reach the server",
      'Check your connection and try again.',
      requestId,
      {},
    );
  }

  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => undefined)) as
    Record<string, unknown> | undefined;
  if (response.ok) return body as T;

  const fieldErrors: Record<string, string> = {};
  if (Array.isArray(body?.errors)) {
    for (const e of body.errors as { path?: string; message?: string }[]) {
      if (e.path && e.message && !fieldErrors[e.path]) fieldErrors[e.path] = e.message;
    }
  }
  const error = new ClientApiError(
    response.status,
    typeof body?.code === 'string' ? body.code : `http_${response.status}`,
    typeof body?.title === 'string' ? body.title : 'Request failed',
    typeof body?.detail === 'string' ? body.detail : undefined,
    typeof body?.request_id === 'string' ? body.request_id : requestId,
    fieldErrors,
  );
  if (response.status >= 500) {
    reportClientEvent({
      level: 'error',
      message: `API ${response.status} on ${path}`,
      request_id: error.requestId,
      context: { code: error.code },
    });
  }
  if (response.status === 401 && typeof window !== 'undefined') {
    window.location.assign(`/sign-in?next=${encodeURIComponent(window.location.pathname)}`);
  }
  return Promise.reject(error);
}
