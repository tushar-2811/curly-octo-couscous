import type { EffectiveRow, GrantRow, ResourceRow } from '@aiw/access';
import type { Member, OrgUnit, Organization, Resource } from '@aiw/db';
import type { EmployeeRow, MemberRow, OrgUnitWithCounts, RoleTemplate } from '@aiw/workforce';

/** API representations. Internal columns (auth_subject, settings) never leave the server. */

export function organizationDto(org: Organization, viewer: Pick<Member, 'person_role'>) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    domain: org.domain,
    domain_verified: org.domain_verified_at !== null,
    // Admins need the token to add the DNS record (slice 6); others don't see it.
    ...(viewer.person_role === 'admin'
      ? { domain_verification_token: org.domain_verification_token }
      : {}),
    status: org.status,
    created_at: toIso(org.created_at),
  };
}

export function memberDto(member: Member) {
  return {
    id: member.id,
    type: member.type,
    display_name: member.display_name,
    email: member.email,
    title: member.title,
    role: member.person_role,
    status: member.status,
    signed_in: member.auth_subject !== null,
    created_at: toIso(member.created_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** A member with their unit and line manager, for lists and detail pages. */
export function memberRowDto(row: MemberRow) {
  return {
    ...memberDto(row),
    org_unit: row.org_unit_id ? { id: row.org_unit_id, name: row.org_unit_name } : null,
    manager: row.manager_id ? { id: row.manager_id, name: row.manager_name } : null,
  };
}

export function orgUnitDto(unit: OrgUnit | OrgUnitWithCounts) {
  return {
    id: unit.id,
    name: unit.name,
    kind: unit.kind,
    parent_id: unit.parent_id,
    ...('member_count' in unit ? { member_count: unit.member_count } : {}),
  };
}

export function roleTemplateDto(t: RoleTemplate) {
  return {
    key: t.key,
    name: t.name,
    summary: t.summary,
    default_title: t.defaultTitle,
    base_instructions: t.baseInstructions,
    capabilities: t.capabilities,
    integrations: t.integrations,
    defaults: {
      max_concurrency: t.defaults.maxConcurrency,
      max_open_tasks: t.defaults.maxOpenTasks,
    },
  };
}

/** An AI employee: member fields, placement and its AI profile. */
export function employeeDto(row: EmployeeRow) {
  return {
    ...memberRowDto(row),
    role_key: row.role_key,
    instructions: row.instructions,
    max_concurrency: row.max_concurrency,
    max_open_tasks: row.max_open_tasks,
    suspension_reason: row.suspension_reason,
    last_error: row.last_error,
  };
}

export function resourceDto(r: Resource | ResourceRow) {
  return {
    id: r.id,
    type: r.type,
    external_id: r.external_id,
    name: r.name,
    url: r.url,
    tags: r.tags,
    archived: r.archived_at !== null,
    created_at: toIso(r.created_at),
    ...('grant_count' in r ? { grant_count: r.grant_count } : {}),
  };
}

export function grantDto(g: GrantRow) {
  return {
    id: g.id,
    resource_type: g.resource_type,
    resource: g.resource_id
      ? {
          id: g.resource_id,
          name: g.resource_name,
          external_id: g.resource_external_id,
          url: g.resource_url,
          archived: g.resource_archived,
        }
      : null,
    effect: g.effect,
    level: g.level,
    tags: g.conditions.tags ?? [],
    branches: g.conditions.branches ?? [],
    granted_by: g.granted_by ? { id: g.granted_by, name: g.granted_by_name } : null,
    created_at: toIso(g.created_at),
    updated_at: toIso(g.updated_at),
    revoked_at: g.revoked_at ? toIso(g.revoked_at) : null,
    revoke_reason: g.revoke_reason,
  };
}

export function effectiveDto(e: EffectiveRow) {
  return {
    resource: e.resource,
    level: e.level,
    branches: e.branches,
    limited_by_deny: e.limited_by_deny,
    grant_ids: e.grant_ids,
  };
}
