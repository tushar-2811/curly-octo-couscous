'use client';

import { RotateCw } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/states';
import { reportClientError } from '@/lib/client-log';

/**
 * Route error boundary. Reports the error (with Next's digest, which matches the server
 * log line) and lets the user retry without losing the rest of the app.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, { boundary: 'route' });
  }, [error]);

  return (
    <ErrorState
      title="This page couldn't load"
      description="Something went wrong while showing this page. You can try again; if it keeps happening, share the error ID with support."
      {...(error.digest ? { digest: error.digest } : {})}
      action={
        <Button variant="secondary" size="sm" onClick={reset}>
          <RotateCw className="size-4" aria-hidden />
          Try again
        </Button>
      }
    />
  );
}
