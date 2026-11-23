/**
 * Expected failures of workforce operations. Each has a stable code; the API maps them
 * to HTTP problems without the module knowing about HTTP.
 */
export class WorkforceError extends Error {
  constructor(
    public readonly code:
      'already_member' | 'domain_taken' | 'domain_not_allowed' | 'not_found' | 'forbidden',
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'WorkforceError';
  }
}
