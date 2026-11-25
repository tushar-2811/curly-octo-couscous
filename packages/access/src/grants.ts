import type {
  Grant,
  GrantConditions,
  GrantEffect,
  GrantLevel,
  Member,
  Resource,
  ResourceType,
  Tx,
} from '@aiw/db';
import { recordChange, type ActorContext } from '@aiw/platform';
import {
  BRANCH_PATTERN,
  INTEGRATION_RESOURCE,
  LEVEL_RANK,
  MAX_BRANCHES,
  RESOURCE_TYPE_INFO,
  type ActionKey,
} from './catalog';
import { AccessError } from './errors';
import { effectiveAccess, evaluate, type Decision, type EffectiveAccess } from './evaluate';
import { getResource, normalizeTags } from './resources';
import { recordRevoke, revokeWhere } from './revoke';

async function loadEmployee(trx: Tx, id: string): Promise<Member> {
  const member = await trx
    .selectFrom('workforce.members')
    .selectAll()
    .where('id', '=', id)
    .where('type', '=', 'ai')
    .executeTakeFirst();
  if (!member) throw new AccessError('not_found', 'AI employee not found');
  return member;
}

/**
 * Admins grant across the org; a person grants to the AI employees they manage
 * (PRD SEC-3). Security admins can additionally revoke anything.
 */
export async function canManageGrants(trx: Tx, actor: Member, employeeId: string) {
  if (actor.type !== 'human' || actor.status !== 'active') return false;
  if (actor.person_role === 'admin') return true;
  const line = await trx
    .selectFrom('workforce.reporting_lines')
    .select('member_id')
    .where('member_id', '=', employeeId)
    .where('manager_member_id', '=', actor.id)
    .where('kind', '=', 'line')
    .executeTakeFirst();
  return line !== undefined;
}

async function requireManage(trx: Tx, actor: Member, employeeId: string) {
  if (!(await canManageGrants(trx, actor, employeeId))) {
    throw new AccessError(
      'forbidden',
      'Only admins and this employee’s manager can change its access',
    );
  }
}

export interface GrantRow extends Grant {
  resource_name: string | null;
  resource_external_id: string | null;
  resource_url: string | null;
  resource_archived: boolean;
  granted_by_name: string | null;
}

export async function listGrants(
  trx: Tx,
  memberId: string,
  opts: { includeRevoked?: boolean } = {},
): Promise<GrantRow[]> {
  await loadEmployee(trx, memberId);
  let query = trx
    .selectFrom('access.grants as g')
    .leftJoin('access.resources as r', 'r.id', 'g.resource_id')
    .leftJoin('workforce.members as by', 'by.id', 'g.granted_by')
    .selectAll('g')
    .select([
      'r.name as resource_name',
      'r.external_id as resource_external_id',
      'r.url as resource_url',
      'r.archived_at as resource_archived_at',
      'by.display_name as granted_by_name',
    ])
    .where('g.member_id', '=', memberId);
  if (!opts.includeRevoked) query = query.where('g.revoked_at', 'is', null);
  const rows = await query.orderBy('g.resource_type').orderBy('g.id').execute();
  return rows.map(({ resource_archived_at, ...g }) => ({
    ...g,
    resource_archived: resource_archived_at !== null,
  }));
}

export interface GrantInput {
  resourceType: ResourceType;
  /** null grants every resource of this type, optionally only those with `tags`. */
  resourceId: string | null;
  effect: GrantEffect;
  level: GrantLevel;
  tags?: string[];
  branches?: string[];
}

/** Check a grant against the catalog and normalise its conditions. */
async function validate(
  trx: Tx,
  input: GrantInput,
): Promise<{ resource: Resource | null; conditions: GrantConditions }> {
  const info = RESOURCE_TYPE_INFO[input.resourceType];
  if (!info.levels.includes(input.level)) {
    throw new AccessError(
      'invalid_grant',
      `${info.plural} can be granted ${info.levels.join(' or ')} access only`,
      'level',
    );
  }

  let resource: Resource | null = null;
  if (input.resourceId) {
    resource = await trx
      .selectFrom('access.resources')
      .selectAll()
      .where('id', '=', input.resourceId)
      .executeTakeFirst()
      .then((r) => r ?? null);
    if (!resource || resource.archived_at || resource.type !== input.resourceType) {
      throw new AccessError('invalid_grant', `Choose a ${info.noun} from the list`, 'resource_id');
    }
  }

  const conditions: GrantConditions = {};
  const tags = normalizeTags(input.tags ?? []);
  if (tags.length > 0) {
    if (input.resourceId) {
      throw new AccessError(
        'invalid_grant',
        'Tags only narrow a grant on every item of a type',
        'tags',
      );
    }
    conditions.tags = tags;
  }

  const branches = [...new Set((input.branches ?? []).map((b) => b.trim()).filter(Boolean))];
  if (branches.length > 0) {
    if (input.resourceType !== 'repo' || input.level === 'read' || input.effect !== 'allow') {
      throw new AccessError(
        'invalid_grant',
        'Branch limits apply to repository write access only',
        'branches',
      );
    }
    if (branches.length > MAX_BRANCHES) {
      throw new AccessError('invalid_grant', `Use at most ${MAX_BRANCHES} branches`, 'branches');
    }
    const bad = branches.find((b) => !BRANCH_PATTERN.test(b));
    if (bad) {
      throw new AccessError(
        'invalid_grant',
        `“${bad}” isn’t a valid branch pattern. Use letters, numbers, / . - _ and *`,
        'branches',
      );
    }
    conditions.branches = branches;
  }
  return { resource, conditions };
}

function snapshot(g: Grant) {
  return {
    resource_type: g.resource_type,
    resource_id: g.resource_id,
    effect: g.effect,
    level: g.level,
    conditions: g.conditions,
  };
}

/** Give an AI employee access to a resource (or every resource of a type), or block it. */
export async function createGrant(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  memberId: string,
  input: GrantInput,
): Promise<Grant> {
  const employee = await loadEmployee(trx, memberId);
  await requireManage(trx, actor, memberId);
  if (employee.status === 'terminated') {
    throw new AccessError('invalid_state', 'A terminated employee can’t be given access');
  }
  const { conditions } = await validate(trx, input);

  const existing = await trx
    .selectFrom('access.grants')
    .select('id')
    .where('member_id', '=', memberId)
    .where('resource_type', '=', input.resourceType)
    .where((eb) =>
      input.resourceId ? eb('resource_id', '=', input.resourceId) : eb('resource_id', 'is', null),
    )
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (existing) {
    throw new AccessError(
      'grant_exists',
      `${employee.display_name} already has a rule for this. Change that rule instead`,
      'resource_id',
    );
  }

  const grant = await trx
    .insertInto('access.grants')
    .values({
      org_id: ctx.orgId,
      member_id: memberId,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      effect: input.effect,
      level: input.level,
      conditions: JSON.stringify(conditions),
      granted_by: actor.id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordChange(
    trx,
    ctx,
    {
      action: 'grant.created',
      resourceType: 'grant',
      resourceId: grant.id,
      details: { member_id: memberId, ...snapshot(grant) },
    },
    {
      type: 'GrantChanged',
      aggregateType: 'member',
      aggregateId: memberId,
      data: { grant_id: grant.id, change: 'created', ...snapshot(grant) },
    },
  );
  return grant;
}

export interface GrantPatch {
  effect?: GrantEffect;
  level?: GrantLevel;
  tags?: string[];
  branches?: string[];
}

async function loadGrant(trx: Tx, memberId: string, grantId: string): Promise<Grant> {
  const grant = await trx
    .selectFrom('access.grants')
    .selectAll()
    .where('id', '=', grantId)
    .where('member_id', '=', memberId)
    .executeTakeFirst();
  if (!grant) throw new AccessError('not_found', 'Access rule not found');
  return grant;
}

/** Change a live grant's level, effect or conditions. Its target stays the same. */
export async function updateGrant(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  memberId: string,
  grantId: string,
  patch: GrantPatch,
): Promise<Grant> {
  const employee = await loadEmployee(trx, memberId);
  await requireManage(trx, actor, memberId);
  if (employee.status === 'terminated') {
    throw new AccessError('invalid_state', 'A terminated employee’s access can’t be changed');
  }
  const before = await loadGrant(trx, memberId, grantId);
  if (before.revoked_at) {
    throw new AccessError('invalid_state', 'This access rule was already revoked');
  }
  const { conditions } = await validate(trx, {
    resourceType: before.resource_type,
    resourceId: before.resource_id,
    effect: patch.effect ?? before.effect,
    level: patch.level ?? before.level,
    tags: patch.tags ?? before.conditions.tags ?? [],
    branches:
      patch.branches ??
      ((patch.level ?? before.level) === 'read' || (patch.effect ?? before.effect) === 'deny'
        ? []
        : (before.conditions.branches ?? [])),
  });
  const after = await trx
    .updateTable('access.grants')
    .set({
      effect: patch.effect ?? before.effect,
      level: patch.level ?? before.level,
      conditions: JSON.stringify(conditions),
      updated_at: new Date(),
    })
    .where('id', '=', grantId)
    .returningAll()
    .executeTakeFirstOrThrow();
  // Narrowed access must reach running work quickly (PRD SEC-11).
  // Any condition change is treated as possibly narrowing; consumers re-check.
  const narrowed =
    after.effect !== before.effect ||
    LEVEL_RANK[after.level] < LEVEL_RANK[before.level] ||
    JSON.stringify(after.conditions) !== JSON.stringify(before.conditions);
  await recordChange(
    trx,
    ctx,
    {
      action: 'grant.updated',
      resourceType: 'grant',
      resourceId: grantId,
      details: { member_id: memberId, before: snapshot(before), after: snapshot(after) },
    },
    {
      type: 'GrantChanged',
      aggregateType: 'member',
      aggregateId: memberId,
      data: { grant_id: grantId, change: 'updated', narrowed, ...snapshot(after) },
    },
  );
  return after;
}

/** Revoke one grant. Managers and admins can; security admins can revoke anything. */
export async function revokeGrant(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  memberId: string,
  grantId: string,
): Promise<void> {
  await loadEmployee(trx, memberId);
  const securityAdmin =
    actor.type === 'human' && actor.status === 'active' && actor.person_role === 'security_admin';
  if (!securityAdmin) await requireManage(trx, actor, memberId);
  const grant = await loadGrant(trx, memberId, grantId);
  if (grant.revoked_at) return;
  const revoked = await trx
    .updateTable('access.grants')
    .set({
      revoked_at: new Date(),
      revoked_by: actor.id,
      revoke_reason: 'manual',
      updated_at: new Date(),
    })
    .where('id', '=', grantId)
    .where('revoked_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  if (revoked) await recordRevoke(trx, ctx, revoked, 'manual');
}

/** Revoke everything an employee holds, for example when it is terminated. */
export async function revokeAllGrants(
  trx: Tx,
  ctx: ActorContext,
  memberId: string,
  reason: string,
): Promise<number> {
  return revokeWhere(trx, ctx, { memberId }, reason);
}

async function liveGrants(trx: Tx, memberId: string, type?: ResourceType) {
  let query = trx
    .selectFrom('access.grants')
    .selectAll()
    .where('member_id', '=', memberId)
    .where('revoked_at', 'is', null);
  if (type) query = query.where('resource_type', '=', type);
  return query.execute();
}

/**
 * authorize(member, action, resource, context): the single permission check every
 * broker and tool calls (Technical architecture §11). Fails closed.
 */
export async function authorize(
  trx: Tx,
  memberId: string,
  action: ActionKey,
  resourceId: string,
  context: { branch?: string | null } = {},
): Promise<Decision> {
  const employee = await loadEmployee(trx, memberId);
  const resource = await getResource(trx, resourceId);
  return evaluate({
    memberStatus: employee.status,
    grants: await liveGrants(trx, memberId, resource.type),
    resource,
    action,
    branch: context.branch ?? null,
  });
}

export interface EffectiveRow extends EffectiveAccess {
  resource: Pick<Resource, 'id' | 'type' | 'name' | 'external_id' | 'url' | 'tags'>;
}

/** The employee's effective permission set: what it can do on each resource now. */
export async function effectivePermissions(trx: Tx, memberId: string): Promise<EffectiveRow[]> {
  const employee = await loadEmployee(trx, memberId);
  const grants = await liveGrants(trx, memberId);
  if (grants.length === 0) return [];
  const types = [...new Set(grants.map((g) => g.resource_type))];
  const resources = await trx
    .selectFrom('access.resources')
    .selectAll()
    .where('type', 'in', types)
    .where('archived_at', 'is', null)
    .orderBy('type')
    .orderBy('name')
    .execute();
  const byId = new Map(resources.map((r) => [r.id, r]));
  return effectiveAccess(employee.status, grants, resources).map((e) => {
    const r = byId.get(e.resource_id)!;
    return {
      ...e,
      resource: {
        id: r.id,
        type: r.type,
        name: r.name,
        external_id: r.external_id,
        url: r.url,
        tags: r.tags,
      },
    };
  });
}

/**
 * The onboarding "grants" check (Architecture refinement §E step 4): the employee needs
 * read access to at least one resource of each type its role's required tools use.
 */
export async function grantsCheck(
  trx: Tx,
  memberId: string,
  requiredIntegrations: readonly string[],
): Promise<{ passed: boolean; detail: string }> {
  const effective = await effectivePermissions(trx, memberId);
  const counts = new Map<ResourceType, number>();
  for (const e of effective) {
    if (e.level) counts.set(e.resource.type, (counts.get(e.resource.type) ?? 0) + 1);
  }
  const needed = [
    ...new Set(
      requiredIntegrations
        .map((i) => INTEGRATION_RESOURCE[i])
        .filter((t): t is ResourceType => t !== undefined),
    ),
  ];
  const missing = needed.filter((t) => !counts.get(t));
  if (missing.length > 0) {
    const names = missing.map((t) => RESOURCE_TYPE_INFO[t].noun);
    return { passed: false, detail: `Needs access to at least one ${names.join(' and one ')}` };
  }
  if (counts.size === 0) return { passed: false, detail: 'Nothing granted yet' };
  const summary = [...counts.entries()].map(
    ([t, n]) => `${n} ${n === 1 ? RESOURCE_TYPE_INFO[t].noun : RESOURCE_TYPE_INFO[t].nouns}`,
  );
  return { passed: true, detail: summary.join(', ') };
}
