import type { GrantConditions, GrantEffect, GrantLevel, ResourceType } from '@aiw/db';
import { ACTIONS, branchMatches, LEVEL_RANK, type ActionKey } from './catalog';

/**
 * Pure permission evaluation, kept free of I/O so it is easy to test and to reuse in
 * workers with cached grants. Deny always wins (Technical architecture §11).
 */

export interface GrantLike {
  id: string;
  resource_type: ResourceType;
  resource_id: string | null;
  effect: GrantEffect;
  level: GrantLevel;
  conditions: GrantConditions;
}

export interface ResourceLike {
  id: string;
  type: ResourceType;
  tags: string[];
  archived_at: Date | string | null;
}

export type DenyReason =
  | 'employee_not_working'
  | 'resource_archived'
  | 'denied_by_grant'
  | 'no_grant'
  | 'branch_required'
  | 'branch_not_allowed';

export type Decision =
  | { allowed: true; reason: 'granted'; grant_id: string; message: string }
  | { allowed: false; reason: DenyReason; grant_id: string | null; message: string };

/** States in which an employee may not use any access at all. */
export const NO_ACCESS_STATES: readonly string[] = ['suspended', 'terminated'];

/** Does this grant apply to this resource? Type-wide grants may be narrowed by tags. */
export function grantCovers(grant: GrantLike, resource: ResourceLike): boolean {
  if (grant.resource_type !== resource.type) return false;
  if (grant.resource_id !== null) return grant.resource_id === resource.id;
  const tags = grant.conditions.tags;
  return !tags?.length || tags.some((t) => resource.tags.includes(t));
}

function deny(reason: DenyReason, message: string, grantId: string | null = null): Decision {
  return { allowed: false, reason, grant_id: grantId, message };
}

export function evaluate(input: {
  memberStatus: string;
  grants: readonly GrantLike[];
  resource: ResourceLike;
  action: ActionKey;
  branch?: string | null;
}): Decision {
  const { memberStatus, grants, resource, action } = input;
  const spec = ACTIONS[action];
  if (NO_ACCESS_STATES.includes(memberStatus)) {
    return deny('employee_not_working', `The employee is ${memberStatus}, so all access is off`);
  }
  if (spec.type !== resource.type) {
    return deny('no_grant', 'This action does not apply to this kind of resource');
  }
  if (resource.archived_at) return deny('resource_archived', 'This resource was removed');

  const needed = LEVEL_RANK[spec.level];
  const covering = grants.filter((g) => grantCovers(g, resource));
  const blocking = covering.find((g) => g.effect === 'deny' && LEVEL_RANK[g.level] <= needed);
  if (blocking) {
    return deny(
      'denied_by_grant',
      `Blocked by a deny rule on ${blocking.level} access`,
      blocking.id,
    );
  }

  const allows = covering.filter((g) => g.effect === 'allow' && LEVEL_RANK[g.level] >= needed);
  if (allows.length === 0) return deny('no_grant', `No ${spec.level} access granted`);

  if ('branch' in spec && spec.branch) {
    const branch = input.branch?.trim();
    const unrestricted = allows.find((g) => !g.conditions.branches?.length);
    if (unrestricted) return granted(unrestricted.id);
    if (!branch) return deny('branch_required', 'Name the branch to check');
    const match = allows.find((g) => g.conditions.branches?.some((p) => branchMatches(p, branch)));
    return match
      ? granted(match.id)
      : deny('branch_not_allowed', `Pushing to ${branch} is not allowed`, allows[0]?.id ?? null);
  }
  return granted(allows[0]!.id);
}

function granted(grantId: string): Decision {
  return { allowed: true, reason: 'granted', grant_id: grantId, message: 'Allowed' };
}

export interface EffectiveAccess {
  resource_id: string;
  level: GrantLevel | null;
  /** Repository write only: allowed branches, or null for any branch. */
  branches: string[] | null;
  /** Set when a deny rule lowered or removed access. */
  limited_by_deny: boolean;
  grant_ids: string[];
}

const BY_RANK: Record<number, GrantLevel | null> = { 0: null, 1: 'read', 2: 'write', 3: 'admin' };

/** What the employee can actually do on each resource, after deny rules. */
export function effectiveAccess(
  memberStatus: string,
  grants: readonly GrantLike[],
  resources: readonly ResourceLike[],
): EffectiveAccess[] {
  if (NO_ACCESS_STATES.includes(memberStatus)) return [];
  const out: EffectiveAccess[] = [];
  for (const resource of resources) {
    if (resource.archived_at) continue;
    const covering = grants.filter((g) => grantCovers(g, resource));
    if (covering.length === 0) continue;
    const allowRank = Math.max(
      0,
      ...covering.filter((g) => g.effect === 'allow').map((g) => LEVEL_RANK[g.level]),
    );
    const denyFrom = Math.min(
      Infinity,
      ...covering.filter((g) => g.effect === 'deny').map((g) => LEVEL_RANK[g.level]),
    );
    const rank = Math.min(allowRank, denyFrom - 1);
    const level = BY_RANK[rank] ?? null;
    let branches: string[] | null = null;
    if (level && LEVEL_RANK[level] >= LEVEL_RANK.write && resource.type === 'repo') {
      const writers = covering.filter((g) => g.effect === 'allow' && g.level !== 'read');
      branches = writers.some((g) => !g.conditions.branches?.length)
        ? null
        : [...new Set(writers.flatMap((g) => g.conditions.branches ?? []))];
    }
    out.push({
      resource_id: resource.id,
      level,
      branches,
      limited_by_deny: denyFrom <= allowRank,
      grant_ids: covering.map((g) => g.id),
    });
  }
  return out;
}
