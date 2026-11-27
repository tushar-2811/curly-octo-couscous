export type GoogleErrorCode =
  | 'reauth_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'bad_request'
  | 'not_configured';

/** A failed Google API call. `retryable` errors are worth trying again later. */
export class GoogleApiError extends Error {
  readonly retryable: boolean;
  constructor(
    public readonly code: GoogleErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GoogleApiError';
    this.retryable = code === 'rate_limited' || code === 'timeout' || code === 'unavailable';
  }
}

export function errorForStatus(status: number, detail: string, api: string): GoogleApiError {
  const msg = `${api}: ${detail}`.slice(0, 500);
  if (status === 401) return new GoogleApiError('reauth_required', msg, status);
  if (status === 403) return new GoogleApiError('forbidden', msg, status);
  if (status === 404) return new GoogleApiError('not_found', msg, status);
  if (status === 409) return new GoogleApiError('conflict', msg, status);
  if (status === 429) return new GoogleApiError('rate_limited', msg, status);
  if (status >= 500) return new GoogleApiError('unavailable', msg, status);
  return new GoogleApiError('bad_request', msg, status);
}
