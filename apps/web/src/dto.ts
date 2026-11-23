import type { Member, Organization } from '@aiw/db';

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
    created_at: toIso(member.created_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
