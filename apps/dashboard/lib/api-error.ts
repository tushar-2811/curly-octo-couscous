/**
 * A failed API call, carrying what the UI needs to show a useful error state and what a
 * developer needs to find the matching server log: status, code and request id.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly title: string,
    public readonly detail: string | undefined,
    public readonly requestId: string,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }

  /** Network failures and timeouts: the API never answered. */
  get isUnreachable(): boolean {
    return this.status === 0;
  }
}

interface ProblemBody {
  code?: unknown;
  title?: unknown;
  detail?: unknown;
  request_id?: unknown;
}

/** Turn a non-2xx response body (RFC 7807 or anything else) into an ApiError. */
export function toApiError(status: number, body: unknown, fallbackRequestId: string): ApiError {
  const problem = (typeof body === 'object' && body !== null ? body : {}) as ProblemBody;
  return new ApiError(
    status,
    typeof problem.code === 'string' ? problem.code : `http_${status}`,
    typeof problem.title === 'string' ? problem.title : 'Request failed',
    typeof problem.detail === 'string' ? problem.detail : undefined,
    typeof problem.request_id === 'string' ? problem.request_id : fallbackRequestId,
  );
}
