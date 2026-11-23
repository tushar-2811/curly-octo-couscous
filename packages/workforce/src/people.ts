import { sql, type Member, type PersonRole, type Tx } from '@aiw/db';
import { recordChange, type ActorContext } from '@aiw/platform';
import { WorkforceError } from './errors';
import { isUniqueViolation, requireAdmin } from './guards';

export interface MemberRow extends Member {
  org_unit_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
}

export interface MemberFilter {
  type?: 'human' | 'ai';
  status?: 'active' | 'deactivated';
  orgUnitId?: string;
  /** Case-insensitive match on name, email or title. */
  q?: string;
}

function baseQuery(trx: Tx) {
  return trx
    .selectFrom('workforce.members as m')
    .leftJoin('workforce.org_units as u', 'u.id', 'm.org_unit_id')
    .leftJoin('workforce.reporting_lines as r', (join) =>
      join.onRef('r.member_id', '=', 'm.id').on('r.kind', '=', 'line'),
    )
    .leftJoin('workforce.members as mgr', 'mgr.id', 'r.manager_member_id')
    .selectAll('m')
    .select([
      'u.name as org_unit_name',
      'mgr.id as manager_id',
      'mgr.display_name as manager_name',
    ]);
}

export async function listMembers(trx: Tx, filter: MemberFilter = {}): Promise<MemberRow[]> {
  let query = baseQuery(trx);
  if (filter.type) query = query.where('m.type', '=', filter.type);
  if (filter.status) query = query.where('m.status', '=', filter.status);
  if (filter.orgUnitId) query = query.where('m.org_unit_id', '=', filter.orgUnitId);
  if (filter.q) {
    const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    query = query.where((eb) =>
      eb.or([
        eb('m.display_name', 'ilike', like),
        eb('m.email', 'ilike', like),
        eb('m.title', 'ilike', like),
      ]),
    );
  }
  return (await query.orderBy('m.display_name').execute()) as MemberRow[];
}

export async function getMemberRow(trx: Tx, id: string): Promise<MemberRow> {
  const row = await baseQuery(trx).where('m.id', '=', id).executeTakeFirst();
  if (!row) throw new WorkforceError('not_found', 'Person not found');
  return row as MemberRow;
}

export async function directReports(trx: Tx, managerId: string) {
  return trx
    .selectFrom('workforce.reporting_lines as r')
    .innerJoin('workforce.members as m', 'm.id', 'r.member_id')
    .select(['m.id', 'm.display_name', 'm.type', 'm.title', 'm.status', 'r.kind'])
    .where('r.manager_member_id', '=', managerId)
    .orderBy('m.display_name')
    .execute();
}

async function checkUnit(trx: Tx, orgUnitId: string | null | undefined): Promise<void> {
  if (!orgUnitId) return;
  const unit = await trx
    .selectFrom('workforce.org_units')
    .select('id')
    .where('id', '=', orgUnitId)
    .executeTakeFirst();
  if (!unit)
    throw new WorkforceError(
      'invalid_parent',
      'Choose an existing department or team',
      'org_unit_id',
    );
}

function snapshot(m: Member) {
  return {
    display_name: m.display_name,
    title: m.title,
    role: m.person_role,
    org_unit_id: m.org_unit_id,
    status: m.status,
  };
}

/**
 * Add a person by email. They get access the first time they sign in with that email
 * (the identity provider proves they own it).
 */
export async function addPerson(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  input: {
    displayName: string;
    email: string;
    title: string | null;
    role: PersonRole;
    orgUnitId: string | null;
    managerId: string | null;
  },
): Promise<Member> {
  requireAdmin(actor);
  await checkUnit(trx, input.orgUnitId);
  const email = input.email.trim().toLowerCase();
  // Checked first so the expected error doesn't abort the transaction; the unique index
  // remains as a backstop for concurrent requests.
  if (
    await trx
      .selectFrom('workforce.members')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst()
  ) {
    throw new WorkforceError(
      'email_taken',
      'Someone in your organization already has this email',
      'email',
    );
  }
  let member: Member;
  try {
    member = await trx
      .insertInto('workforce.members')
      .values({
        org_id: ctx.orgId,
        type: 'human',
        display_name: input.displayName.trim(),
        email,
        title: input.title?.trim() || null,
        person_role: input.role,
        org_unit_id: input.orgUnitId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    if (isUniqueViolation(err, 'members_org_email_uq')) {
      throw new WorkforceError(
        'email_taken',
        'Someone in your organization already has this email',
        'email',
      );
    }
    throw err;
  }
  await recordChange(
    trx,
    ctx,
    {
      action: 'member.added',
      resourceType: 'member',
      resourceId: member.id,
      details: { type: 'human', email, ...snapshot(member) },
    },
    {
      type: 'MemberAdded',
      aggregateType: 'member',
      aggregateId: member.id,
      data: { type: 'human', role: input.role },
    },
  );
  if (input.managerId) await setLineManager(trx, ctx, actor, member.id, input.managerId);
  return member;
}

/** Count other active admins, locking their rows so two demotions can't race past zero. */
async function activeAdminCount(trx: Tx, excludingId: string): Promise<number> {
  const result = await sql<{ n: string }>`
    select count(*) as n from (
      select id from workforce.members
      where type = 'human' and person_role = 'admin' and status = 'active' and id <> ${excludingId}
      for update
    ) admins
  `.execute(trx);
  return Number(result.rows[0]?.n ?? 0);
}

/** Edit a person's profile, role, unit or status. Admins only; audited before/after. */
export async function updateMember(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  id: string,
  patch: {
    displayName?: string;
    title?: string | null;
    role?: PersonRole;
    orgUnitId?: string | null;
    status?: 'active' | 'deactivated';
  },
): Promise<Member> {
  requireAdmin(actor);
  const before = await trx
    .selectFrom('workforce.members')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!before) throw new WorkforceError('not_found', 'Person not found');

  if (patch.status === 'deactivated' && id === actor.id) {
    throw new WorkforceError('forbidden', 'You can’t deactivate yourself', 'status');
  }
  const losesAdmin =
    before.person_role === 'admin' &&
    before.status === 'active' &&
    ((patch.role !== undefined && patch.role !== 'admin') || patch.status === 'deactivated');
  if (losesAdmin && (await activeAdminCount(trx, id)) === 0) {
    throw new WorkforceError(
      'last_admin',
      'Your organization needs at least one active admin',
      patch.role !== undefined ? 'role' : 'status',
    );
  }
  if (patch.orgUnitId !== undefined) await checkUnit(trx, patch.orgUnitId);

  const changes = {
    ...(patch.displayName !== undefined ? { display_name: patch.displayName.trim() } : {}),
    ...(patch.title !== undefined ? { title: patch.title?.trim() || null } : {}),
    // Roles apply to people only; AI employees are governed by grants.
    ...(patch.role !== undefined && before.type === 'human' ? { person_role: patch.role } : {}),
    ...(patch.orgUnitId !== undefined ? { org_unit_id: patch.orgUnitId } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  };
  if (Object.keys(changes).length === 0) return before;
  const after = await trx
    .updateTable('workforce.members')
    .set({ ...changes, updated_at: new Date() })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const statusChanged = patch.status !== undefined && patch.status !== before.status;
  await recordChange(
    trx,
    ctx,
    {
      action: statusChanged ? `member.${after.status}` : 'member.updated',
      resourceType: 'member',
      resourceId: id,
      details: { before: snapshot(before), after: snapshot(after) },
    },
    statusChanged
      ? {
          type: 'MemberStateChanged',
          aggregateType: 'member',
          aggregateId: id,
          data: { from: before.status, to: after.status },
        }
      : { type: 'MemberUpdated', aggregateType: 'member', aggregateId: id, data: snapshot(after) },
  );
  return after;
}

/**
 * Set or clear a member's line manager. The manager must be an active member, and the
 * chain may not loop back to the member.
 */
export async function setLineManager(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  memberId: string,
  managerId: string | null,
): Promise<void> {
  requireAdmin(actor);
  const member = await trx
    .selectFrom('workforce.members')
    .select('id')
    .where('id', '=', memberId)
    .executeTakeFirst();
  if (!member) throw new WorkforceError('not_found', 'Person not found');
  const current = await trx
    .selectFrom('workforce.reporting_lines')
    .select('manager_member_id')
    .where('member_id', '=', memberId)
    .where('kind', '=', 'line')
    .executeTakeFirst();
  if ((current?.manager_member_id ?? null) === managerId) return;

  if (managerId) {
    if (managerId === memberId)
      throw new WorkforceError('invalid_manager', 'Someone can’t manage themselves', 'manager_id');
    const manager = await trx
      .selectFrom('workforce.members')
      .select(['id', 'status'])
      .where('id', '=', managerId)
      .executeTakeFirst();
    if (!manager || manager.status !== 'active') {
      throw new WorkforceError(
        'invalid_manager',
        'Choose an active person as manager',
        'manager_id',
      );
    }
    const chain = await sql<{ id: string }>`
      with recursive up as (
        select manager_member_id as id, 1 as depth from workforce.reporting_lines
          where member_id = ${managerId} and kind = 'line'
        union all
        select r.manager_member_id, up.depth + 1 from workforce.reporting_lines r join up on r.member_id = up.id
          where r.kind = 'line' and up.depth < 100
      )
      select id from up
    `.execute(trx);
    if (chain.rows.some((r) => r.id === memberId)) {
      throw new WorkforceError('cycle', 'That would make a reporting loop', 'manager_id');
    }
  }

  await trx
    .deleteFrom('workforce.reporting_lines')
    .where('member_id', '=', memberId)
    .where('kind', '=', 'line')
    .execute();
  if (managerId) {
    await trx
      .insertInto('workforce.reporting_lines')
      .values({
        org_id: ctx.orgId,
        member_id: memberId,
        manager_member_id: managerId,
        kind: 'line',
      })
      .execute();
  }
  await recordChange(
    trx,
    ctx,
    {
      action: 'member.manager_changed',
      resourceType: 'member',
      resourceId: memberId,
      details: { before: current?.manager_member_id ?? null, after: managerId },
    },
    {
      type: 'ReportingLineChanged',
      aggregateType: 'member',
      aggregateId: memberId,
      data: { manager_member_id: managerId, kind: 'line' },
    },
  );
}
