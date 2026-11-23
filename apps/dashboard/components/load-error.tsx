import { RetryButton } from '@/components/retry-button';
import { ErrorState } from '@/components/ui/states';
import { ApiError } from '@/lib/api-error';

/** Error state for a page whose data failed to load. Non-API errors go to the boundary. */
export function LoadError({ error, what }: { error: unknown; what: string }) {
  if (!(error instanceof ApiError)) throw error;
  return (
    <ErrorState
      title={error.isUnreachable ? error.title : `Couldn't load ${what}`}
      description={error.detail ?? 'Something went wrong on our side. Try again in a moment.'}
      requestId={error.requestId}
      action={<RetryButton />}
    />
  );
}
