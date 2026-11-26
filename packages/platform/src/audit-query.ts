import type { AuditLog, Tx } from '@aiw/db';

/**
 * Reading the audit log (Technical architecture §9: audit search). Newest first, keyset
 * paging on the id (UUIDv7, so id order is time order). Call inside withTenant: row-level
 * security limits results to the organization.
 */
export interface AuditFilter {
  /** A member id, or "system" for automatic changes. */
  actor?: string;
  /** Everything that happened to one member, unit or organization. */
  resourceId?: string;
  /** The part before the dot, e.g. "member" or "identity". */
  category?: string;
  action?: string;
  outcome?: 'success' | 'denied' | 'failure';
  from?: Date;
  /** Exclusive. */
  to?: Date;
  /** Return entries older than this id. */
  before?: string;
  limit: number;
}

export async function searchAudit(
  trx: Tx,
  filter: AuditFilter,
): Promise<{ entries: AuditLog[]; nextCursor: string | null }> {
  let query = trx.selectFrom('platform.audit_logs').selectAll();
  if (filter.actor === 'system') query = query.where('actor_type', '=', 'system');
  else if (filter.actor) query = query.where('actor_member_id', '=', filter.actor);
  if (filter.resourceId) query = query.where('resource_id', '=', filter.resourceId);
  if (filter.category) query = query.where('action', 'like', `${filter.category}.%`);
  if (filter.action) query = query.where('action', '=', filter.action);
  if (filter.outcome) query = query.where('outcome', '=', filter.outcome);
  if (filter.from) query = query.where('occurred_at', '>=', filter.from);
  if (filter.to) query = query.where('occurred_at', '<', filter.to);
  if (filter.before) query = query.where('id', '<', filter.before);
  // One extra row tells us whether there is another page.
  const rows = await query
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const entries = rows.slice(0, filter.limit);
  return {
    entries,
    nextCursor: rows.length > filter.limit ? (entries.at(-1)?.id ?? null) : null,
  };
}

/** Values for the filter menus: who has done things, and which actions exist. */
export async function auditFacets(
  trx: Tx,
): Promise<{ actorIds: string[]; actions: string[]; hasSystem: boolean }> {
  const [actors, actions, system] = await Promise.all([
    trx
      .selectFrom('platform.audit_logs')
      .select('actor_member_id')
      .distinct()
      .where('actor_member_id', 'is not', null)
      .execute(),
    trx.selectFrom('platform.audit_logs').select('action').distinct().orderBy('action').execute(),
    trx
      .selectFrom('platform.audit_logs')
      .select('id')
      .where('actor_type', '=', 'system')
      .limit(1)
      .executeTakeFirst(),
  ]);
  return {
    actorIds: actors.map((a) => a.actor_member_id!),
    actions: actions.map((a) => a.action),
    hasSystem: system !== undefined,
  };
}
