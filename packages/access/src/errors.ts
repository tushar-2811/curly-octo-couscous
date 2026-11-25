export type AccessErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_state'
  | 'resource_exists'
  | 'grant_exists'
  | 'invalid_resource'
  | 'invalid_grant';

/**
 * Expected failures of access operations, with a stable code the API maps to an HTTP
 * problem. `field` names the form field the message belongs to, when there is one.
 */
export class AccessError extends Error {
  constructor(
    public readonly code: AccessErrorCode,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}
