import { describe, expect, it } from 'vitest';
import { toApiError } from './api-error';

describe('toApiError', () => {
  it('reads an RFC 7807 problem body, preferring its request id', () => {
    const error = toApiError(
      503,
      {
        code: 'dependency_unavailable',
        title: 'A dependency is unavailable',
        detail: 'Failed: database',
        request_id: 'srv-1',
      },
      'client-1',
    );
    expect(error).toMatchObject({
      status: 503,
      code: 'dependency_unavailable',
      detail: 'Failed: database',
      requestId: 'srv-1',
    });
    expect(error.isUnreachable).toBe(false);
  });

  it('falls back safely for non-problem bodies', () => {
    const error = toApiError(502, '<html>Bad gateway</html>', 'client-2');
    expect(error).toMatchObject({
      code: 'http_502',
      title: 'Request failed',
      requestId: 'client-2',
    });
  });
});
