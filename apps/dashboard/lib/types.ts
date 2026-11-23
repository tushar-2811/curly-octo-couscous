/** API shapes used by the dashboard (mirrors apps/web/src/dto.ts). */

export interface Organization {
  id: string;
  name: string;
  slug: string;
  domain: string;
  domain_verified: boolean;
  domain_verification_token?: string;
  status: 'active' | 'suspended';
  created_at: string;
}

export type PersonRole = 'admin' | 'security_admin' | 'manager' | 'member';

export interface Member {
  id: string;
  type: 'human' | 'ai';
  display_name: string;
  email: string | null;
  title: string | null;
  role: PersonRole | null;
  status: string;
  signed_in: boolean;
  created_at: string;
}

/** A member with their unit and line manager (lists, detail pages). */
export interface MemberRow extends Member {
  org_unit: { id: string; name: string | null } | null;
  manager: { id: string; name: string | null } | null;
}

export type OrgUnitKind = 'department' | 'team' | 'other';

export interface OrgUnit {
  id: string;
  name: string;
  kind: OrgUnitKind;
  parent_id: string | null;
  member_count?: number;
}

export const UNIT_KIND_LABELS: Record<OrgUnitKind, string> = {
  department: 'Department',
  team: 'Team',
  other: 'Group',
};

export interface Me {
  user: { email: string; name: string };
  member: Member | null;
  organization: Organization | null;
}

export const ROLE_LABELS: Record<PersonRole, string> = {
  admin: 'Admin',
  security_admin: 'Security admin',
  manager: 'Manager',
  member: 'Member',
};

export interface DirectReport {
  id: string;
  display_name: string;
  type: 'human' | 'ai';
  title: string | null;
  status: string;
  kind: 'line' | 'dotted';
}
