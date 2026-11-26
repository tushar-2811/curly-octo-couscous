import type { ExternalIdentity, Member, OrgUnit, Organization } from '@aiw/db';
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

/** A linked account. The credential reference and tokens never leave the server. */
export function identityDto(i: ExternalIdentity) {
  return {
    id: i.id,
    provider: i.provider,
    email: i.email_address,
    hosted_domain: i.hosted_domain,
    authentication_status: i.authentication_status,
    connection_status: i.connection_status,
    granted_scopes: i.granted_scopes,
    connected_at: toIso(i.connected_at),
    last_verified_at: i.last_verified_at ? toIso(i.last_verified_at) : null,
    disconnected_at: i.disconnected_at ? toIso(i.disconnected_at) : null,
  };
}
