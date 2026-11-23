import type { Member } from '@aiw/db';
import { WorkforceError } from './errors';

/** Org structure and people are managed by admins (managers get scoped rights later). */
export function requireAdmin(actor: Member): void {
  if (actor.type !== 'human' || actor.person_role !== 'admin') {
    throw new WorkforceError('forbidden', 'Only organization admins can do this');
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
