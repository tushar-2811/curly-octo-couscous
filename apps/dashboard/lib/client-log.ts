'use client';

type Level = 'error' | 'warn' | 'info';

interface ClientEvent {
  level: Level;
  message: string;
  digest?: string;
  stack?: string;
  route?: string;
  url?: string;
  user_agent?: string;
  request_id?: string;
  occurred_at?: string;
  context?: Record<string, string | number | boolean>;
}

const recent = new Map<string, number>();

/**
 * Send a browser-side event to the API's client-log endpoint so it appears in the server
 * logs (source=dashboard). Never throws; identical events within 10 seconds are sent once
 * so a render loop cannot flood the logs.
 */
export function reportClientEvent(
  event: Omit<ClientEvent, 'url' | 'user_agent' | 'occurred_at' | 'route'>,
): void {
  if (typeof window === 'undefined') return;
  const key = `${event.level}:${event.message}:${event.digest ?? ''}`;
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now - 10_000) return;
  recent.set(key, now);

  const payload: ClientEvent = {
    ...event,
    message: event.message.slice(0, 2000),
    ...(event.stack ? { stack: event.stack.slice(0, 8000) } : {}),
    route: window.location.pathname,
    url: window.location.href.slice(0, 2000),
    user_agent: navigator.userAgent.slice(0, 500),
    occurred_at: new Date().toISOString(),
  };
  try {
    void fetch('/api/v1/client-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [payload] }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Reporting must never break the page.
  }
}

export function reportClientError(
  error: Error & { digest?: string },
  context?: Record<string, string | number | boolean>,
): void {
  reportClientEvent({
    level: 'error',
    message: error.message || error.name || 'Unknown error',
    ...(error.digest ? { digest: error.digest } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
    ...(context ? { context } : {}),
  });
}
