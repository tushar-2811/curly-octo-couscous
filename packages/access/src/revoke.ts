import type { Grant, Tx } from '@aiw/db';
import { recordChange, type ActorContext } from '@aiw/platform';

/**
 * Revoke live grants in bulk (resource removed, employee terminated). Each grant gets its
 * own audit entry and GrantRevoked event, so running work that used it can be stopped.
 */
export async function revokeWhere(
  trx: Tx,
  ctx: ActorContext,
  where: { resourceId?: string; memberId?: string },
  reason: string,
): Promise<number> {
  let query = trx
    .updateTable('access.grants')
    .set({
      revoked_at: new Date(),
      revoked_by: ctx.actorMemberId,
      revoke_reason: reason,
      updated_at: new Date(),
    })
    .where('revoked_at', 'is', null);
  if (where.resourceId) query = query.where('resource_id', '=', where.resourceId);
  if (where.memberId) query = query.where('member_id', '=', where.memberId);
  const rows = await query.returningAll().execute();
  for (const grant of rows) await recordRevoke(trx, ctx, grant, reason);
  return rows.length;
}

export async function recordRevoke(
  trx: Tx,
  ctx: ActorContext,
  grant: Grant,
  reason: string,
): Promise<void> {
  await recordChange(
    trx,
    ctx,
    {
      action: 'grant.revoked',
      resourceType: 'grant',
      resourceId: grant.id,
      details: {
        member_id: grant.member_id,
        resource_type: grant.resource_type,
        resource_id: grant.resource_id,
        effect: grant.effect,
        level: grant.level,
        reason,
      },
    },
    {
      type: 'GrantRevoked',
      aggregateType: 'member',
      aggregateId: grant.member_id,
      data: {
        grant_id: grant.id,
        resource_type: grant.resource_type,
        resource_id: grant.resource_id,
        reason,
      },
    },
  );
}
