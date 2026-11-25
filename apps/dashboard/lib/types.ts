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

export type AiState =
  | 'draft'
  | 'external_identity_pending'
  | 'identity_connected'
  | 'integrations_pending'
  | 'permissions_configured'
  | 'environment_ready'
  | 'active'
  | 'onboarding_failed'
  | 'suspended'
  | 'terminated';

export const AI_STATE_LABELS: Record<AiState, string> = {
  draft: 'Draft',
  external_identity_pending: 'Waiting for Google account',
  identity_connected: 'Google account linked',
  integrations_pending: 'Waiting for tools',
  permissions_configured: 'Permissions set',
  environment_ready: 'Environment ready',
  active: 'Active',
  onboarding_failed: 'Onboarding failed',
  suspended: 'Suspended',
  terminated: 'Terminated',
};

export interface RoleTemplate {
  key: string;
  name: string;
  summary: string;
  default_title: string;
  base_instructions: string;
  capabilities: string[];
  integrations: { key: string; required: boolean }[];
  defaults: { max_concurrency: number; max_open_tasks: number };
}

export interface Employee extends MemberRow {
  status: AiState;
  role_key: string;
  instructions: string;
  max_concurrency: number;
  max_open_tasks: number;
  suspension_reason: string | null;
  last_error: string | null;
}

export interface OnboardingCheck {
  key: string;
  label: string;
  status: 'passed' | 'pending' | 'failed';
  required: boolean;
  detail: string;
}

export interface EmployeeDetail {
  employee: Employee;
  template: RoleTemplate | null;
  onboarding: { state: AiState; onboarding: boolean; checks: OnboardingCheck[] };
}

export type ResourceType = 'repo' | 'jira_project' | 'chat_space' | 'figma_file';
export type GrantLevel = 'read' | 'write';

export interface ResourceTypeInfo {
  key: ResourceType;
  label: string;
  plural: string;
  noun: string;
  nouns: string;
  levels: { key: GrantLevel; help: string }[];
  external_id: { example: string; hint: string };
}

export interface ActionInfo {
  key: string;
  resource_type: ResourceType;
  level: GrantLevel;
  label: string;
  needs_branch: boolean;
}

export interface AccessCatalog {
  resource_types: ResourceTypeInfo[];
  actions: ActionInfo[];
}

export interface Resource {
  id: string;
  type: ResourceType;
  external_id: string;
  name: string;
  url: string | null;
  tags: string[];
  archived: boolean;
  created_at: string;
  grant_count?: number;
}

export interface Grant {
  id: string;
  resource_type: ResourceType;
  resource: {
    id: string;
    name: string | null;
    external_id: string | null;
    url: string | null;
    archived: boolean;
  } | null;
  effect: 'allow' | 'deny';
  level: GrantLevel;
  tags: string[];
  branches: string[];
  granted_by: { id: string; name: string | null } | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface EffectiveAccess {
  resource: Pick<Resource, 'id' | 'type' | 'name' | 'external_id' | 'url' | 'tags'>;
  level: GrantLevel | null;
  branches: string[] | null;
  limited_by_deny: boolean;
  grant_ids: string[];
}

export interface EmployeeAccess {
  grants: Grant[];
  effective: EffectiveAccess[];
  can_manage: boolean;
  can_revoke: boolean;
}

export interface AccessDecision {
  allowed: boolean;
  reason: string;
  grant_id: string | null;
  message: string;
}
