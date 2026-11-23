import { sql, type Member, type OrgUnit, type OrgUnitKind, type Tx } from '@aiw/db';
import { recordChange, type ActorContext } from '@aiw/platform';
import { WorkforceError } from './errors';
import { isUniqueViolation, requireAdmin } from './guards';

export const MAX_UNIT_DEPTH = 6;

export interface OrgUnitWithCounts extends OrgUnit {
  member_count: number;
}

/** All units with the number of current members (people and AI) directly in each. */
export async function listOrgUnits(trx: Tx): Promise<OrgUnitWithCounts[]> {
  const rows = await trx
    .selectFrom('workforce.org_units as u')
    .leftJoin('workforce.members as m', (join) =>
      join
        .onRef('m.org_unit_id', '=', 'u.id')
        .on('m.status', 'not in', ['deactivated', 'terminated']),
    )
    .selectAll('u')
    .select((eb) => eb.fn.count<string>('m.id').as('member_count'))
    .groupBy('u.id')
    .orderBy('u.name')
    .execute();
  return rows.map((r) => ({ ...r, member_count: Number(r.member_count) }));
}

export async function getOrgUnit(trx: Tx, id: string): Promise<OrgUnit> {
  const unit = await trx
    .selectFrom('workforce.org_units')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!unit) throw new WorkforceError('not_found', 'Department or team not found');
  return unit;
}

/** Ids from `id` up to the root, nearest first (including `id`). */
async function ancestry(trx: Tx, id: string): Promise<string[]> {
  const result = await sql<{ id: string }>`
    with recursive up as (
      select id, parent_id, 1 as depth from workforce.org_units where id = ${id}
      union all
      select u.id, u.parent_id, up.depth + 1 from workforce.org_units u join up on u.id = up.parent_id
      where up.depth < 50
    )
    select id from up order by depth
  `.execute(trx);
  return result.rows.map((r) => r.id);
}

async function checkParent(trx: Tx, parentId: string | null, movingId?: string): Promise<void> {
  if (!parentId) return;
  const parent = await trx
    .selectFrom('workforce.org_units')
    .select('id')
    .where('id', '=', parentId)
    .executeTakeFirst();
  if (!parent)
    throw new WorkforceError(
      'invalid_parent',
      'Choose an existing department or team',
      'parent_id',
    );
  const chain = await ancestry(trx, parentId);
  if (movingId && chain.includes(movingId)) {
    throw new WorkforceError(
      'cycle',
      'A department or team can’t be moved inside itself or one of its own teams',
      'parent_id',
    );
  }
  if (chain.length + 1 > MAX_UNIT_DEPTH) {
    throw new WorkforceError(
      'too_deep',
      `Departments and teams can be nested at most ${MAX_UNIT_DEPTH} levels deep`,
      'parent_id',
    );
  }
}

/**
 * Check sibling-name uniqueness before writing, so the expected error doesn't abort the
 * surrounding transaction. The unique index stays as a backstop for races.
 */
async function assertNameFree(
  trx: Tx,
  name: string,
  parentId: string | null,
  exceptId?: string,
): Promise<void> {
  let query = trx
    .selectFrom('workforce.org_units')
    .select('id')
    .where(sql<boolean>`lower(name) = lower(${name.trim()})`)
    .where(parentId ? sql<boolean>`parent_id = ${parentId}` : sql<boolean>`parent_id is null`);
  if (exceptId) query = query.where('id', '<>', exceptId);
  if (await query.executeTakeFirst()) {
    throw new WorkforceError(
      'name_taken',
      'There’s already a department or team with this name here',
      'name',
    );
  }
}

function nameTaken(err: unknown): never | void {
  if (isUniqueViolation(err, 'org_units_sibling_name_uq')) {
    throw new WorkforceError(
      'name_taken',
      'There’s already a department or team with this name here',
      'name',
    );
  }
}

export async function createOrgUnit(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  input: { name: string; kind: OrgUnitKind; parentId: string | null },
): Promise<OrgUnit> {
  requireAdmin(actor);
  await checkParent(trx, input.parentId);
  await assertNameFree(trx, input.name, input.parentId);
  try {
    const unit = await trx
      .insertInto('workforce.org_units')
      .values({
        org_id: ctx.orgId,
        parent_id: input.parentId,
        kind: input.kind,
        name: input.name.trim(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordChange(
      trx,
      ctx,
      {
        action: 'org_unit.created',
        resourceType: 'org_unit',
        resourceId: unit.id,
        details: { name: unit.name, kind: unit.kind, parent_id: unit.parent_id },
      },
      {
        type: 'OrgUnitCreated',
        aggregateType: 'org_unit',
        aggregateId: unit.id,
        data: { name: unit.name, kind: unit.kind, parent_id: unit.parent_id },
      },
    );
    return unit;
  } catch (err) {
    nameTaken(err);
    throw err;
  }
}

/** Rename, change kind, or move under another parent (null = top level). */
export async function updateOrgUnit(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  id: string,
  patch: { name?: string; kind?: OrgUnitKind; parentId?: string | null },
): Promise<OrgUnit> {
  requireAdmin(actor);
  const before = await getOrgUnit(trx, id);
  if (patch.parentId !== undefined && patch.parentId !== before.parent_id) {
    if (patch.parentId === id) {
      throw new WorkforceError(
        'cycle',
        'A department or team can’t be moved inside itself',
        'parent_id',
      );
    }
    await checkParent(trx, patch.parentId, id);
  }
  const changes = {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.parentId !== undefined ? { parent_id: patch.parentId } : {}),
  };
  if (Object.keys(changes).length === 0) return before;
  if (changes.name !== undefined || changes.parent_id !== undefined) {
    await assertNameFree(
      trx,
      changes.name ?? before.name,
      changes.parent_id !== undefined ? changes.parent_id : before.parent_id,
      id,
    );
  }
  try {
    const after = await trx
      .updateTable('workforce.org_units')
      .set({ ...changes, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const pick = (u: OrgUnit) => ({ name: u.name, kind: u.kind, parent_id: u.parent_id });
    await recordChange(
      trx,
      ctx,
      {
        action: 'org_unit.updated',
        resourceType: 'org_unit',
        resourceId: id,
        details: { before: pick(before), after: pick(after) },
      },
      { type: 'OrgUnitUpdated', aggregateType: 'org_unit', aggregateId: id, data: pick(after) },
    );
    return after;
  } catch (err) {
    nameTaken(err);
    throw err;
  }
}

/** Delete an empty unit. Units with teams or people inside are refused. */
export async function deleteOrgUnit(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  id: string,
): Promise<void> {
  requireAdmin(actor);
  const unit = await getOrgUnit(trx, id);
  const child = await trx
    .selectFrom('workforce.org_units')
    .select('id')
    .where('parent_id', '=', id)
    .executeTakeFirst();
  const member = await trx
    .selectFrom('workforce.members')
    .select('id')
    .where('org_unit_id', '=', id)
    .executeTakeFirst();
  if (child || member) {
    throw new WorkforceError(
      'unit_not_empty',
      child
        ? 'Move or delete its teams first'
        : 'Move its people to another department or team first',
    );
  }
  await trx.deleteFrom('workforce.org_units').where('id', '=', id).execute();
  await recordChange(
    trx,
    ctx,
    {
      action: 'org_unit.deleted',
      resourceType: 'org_unit',
      resourceId: id,
      details: { name: unit.name, kind: unit.kind },
    },
    {
      type: 'OrgUnitDeleted',
      aggregateType: 'org_unit',
      aggregateId: id,
      data: { name: unit.name },
    },
  );
}
