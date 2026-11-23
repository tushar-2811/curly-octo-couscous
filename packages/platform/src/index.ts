/**
 * Platform module: audit log and transactional outbox (Technical architecture §4, §11).
 *
 * Both are written with the same transaction as the change they describe, so a change
 * is never visible without its audit record and event, and vice versa.
 */
import { createHash } from 'node:crypto';
import type { Tx } from '@aiw/db';

/** Who is acting and for which request; passed from the API layer into module code. */
export interface ActorContext {
  orgId: string;
  actorMemberId: string | null;
  requestId: string | null;
}

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome?: 'success' | 'denied' | 'failure';
  /** Small, non-secret facts about the change, such as before/after values. */
  details?: Record<string, unknown>;
}

export interface DomainEvent {
  type: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  data?: Record<string, unknown>;
}

/** Stable JSON (sorted keys) so the same content always hashes the same way. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export async function recordAudit(trx: Tx, ctx: ActorContext, entry: AuditEntry): Promise<void> {
  const details = entry.details ?? {};
  const detailsHash = createHash('sha256')
    .update(
      stableStringify({
        org: ctx.orgId,
        actor: ctx.actorMemberId,
        action: entry.action,
        resource: [entry.resourceType, entry.resourceId ?? null],
        details,
      }),
    )
    .digest('hex');
  await trx
    .insertInto('platform.audit_logs')
    .values({
      org_id: ctx.orgId,
      actor_type: ctx.actorMemberId ? 'member' : 'system',
      actor_member_id: ctx.actorMemberId,
      on_behalf_of_member_id: null,
      task_id: null,
      execution_id: null,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId ?? null,
      outcome: entry.outcome ?? 'success',
      request_id: ctx.requestId,
      details: JSON.stringify(details),
      details_hash: detailsHash,
      details_uri: null,
    })
    .execute();
}

export async function emitEvent(trx: Tx, ctx: ActorContext, event: DomainEvent): Promise<void> {
  await trx
    .insertInto('platform.outbox_events')
    .values({
      org_id: ctx.orgId,
      type: event.type,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      aggregate_version: event.aggregateVersion ?? 1,
      data: JSON.stringify(event.data ?? {}),
      request_id: ctx.requestId,
      next_attempt_at: null,
    })
    .execute();
}

/** Record an audited change and, optionally, its domain event in one call. */
export async function recordChange(
  trx: Tx,
  ctx: ActorContext,
  audit: AuditEntry,
  event?: DomainEvent,
): Promise<void> {
  await recordAudit(trx, ctx, audit);
  if (event) await emitEvent(trx, ctx, event);
}
