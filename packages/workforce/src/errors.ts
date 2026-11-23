export type WorkforceErrorCode =
  | 'already_member'
  | 'domain_taken'
  | 'domain_not_allowed'
  | 'not_found'
  | 'forbidden'
  | 'name_taken'
  | 'email_taken'
  | 'invalid_parent'
  | 'unit_not_empty'
  | 'too_deep'
  | 'invalid_manager'
  | 'cycle'
  | 'last_admin'
  | 'invalid_state'
  | 'unknown_template'
  | 'email_domain';

/**
 * Expected failures of workforce operations. Each has a stable code; the API maps them
 * to HTTP problems without the module knowing about HTTP. `field` names the form field
 * the message belongs to, when there is one.
 */
export class WorkforceError extends Error {
  constructor(
    public readonly code: WorkforceErrorCode,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'WorkforceError';
  }
}
