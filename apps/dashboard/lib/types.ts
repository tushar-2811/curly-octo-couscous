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
  created_at: string;
}

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
