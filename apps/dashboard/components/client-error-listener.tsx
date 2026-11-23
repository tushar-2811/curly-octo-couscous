'use client';

import { useEffect } from 'react';
import { reportClientError, reportClientEvent } from '@/lib/client-log';

/**
 * Catches browser errors that never reach a React error boundary (event handlers,
 * timers, rejected promises) and sends them to the server logs.
 */
export function ClientErrorListener() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (event.error instanceof Error) reportClientError(event.error, { kind: 'window.error' });
      else
        reportClientEvent({
          level: 'error',
          message: event.message || 'Unknown window error',
          context: { kind: 'window.error' },
        });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      if (reason instanceof Error) reportClientError(reason, { kind: 'unhandledrejection' });
      else
        reportClientEvent({
          level: 'error',
          message: `Unhandled rejection: ${String(reason)}`,
          context: { kind: 'unhandledrejection' },
        });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
