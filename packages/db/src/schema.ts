import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Kysely table types, keyed "schema.table". Each module owns one Postgres schema
 * (Technical architecture §2); tables are added as features land.
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T = unknown> = ColumnType<T, T | string | undefined, T | string>;

/** Versioned JSONB settings document (Core Orchestrator design §18.2). */
export interface SettingsDocument<V = Record<string, unknown>> {
  schema: string;
  revision: number;
  updatedAt?: string;
  updatedBy?: string;
  value: V;
}

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  domain: string;
  domain_verification_token: string;
  domain_verified_at: Timestamp | null;
  google_customer_id: string | null;
  status: Generated<'active' | 'suspended'>;
  data_region: Generated<string>;
  settings: Generated<Json<SettingsDocument>>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type MemberType = 'human' | 'ai';
export type PersonRole = 'admin' | 'security_admin' | 'manager' | 'member';

export interface MembersTable {
  id: Generated<string>;
  org_id: string;
  type: MemberType;
  display_name: string;
  email: string | null;
  title: string | null;
  person_role: PersonRole | null;
  auth_subject: string | null;
  status: Generated<string>;
  onboarding_checks: Json<SettingsDocument> | null;
  org_unit_id: string | null;
  suspension_reason: SuspensionReason | null;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** AI employee lifecycle (Identity linking §2). People use 'active' | 'deactivated'. */
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

export type SuspensionReason =
  | 'identity_revoked'
  | 'token_invalid'
  | 'integration_lost'
  | 'budget_exhausted'
  | 'manual'
  | 'security';

export interface AiProfilesTable {
  member_id: string;
  org_id: string;
  role_key: string;
  instructions: Generated<string>;
  /** JSON array; insert or update with a JSON string. */
  capabilities: ColumnType<string[], string | undefined, string>;
  max_concurrency: Generated<number>;
  max_open_tasks: Generated<number>;
  model_policy: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type OrgUnitKind = 'department' | 'team' | 'other';

export interface OrgUnitsTable {
  id: Generated<string>;
  org_id: string;
  parent_id: string | null;
  kind: OrgUnitKind;
  name: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type ReportingKind = 'line' | 'dotted';

export interface ReportingLinesTable {
  org_id: string;
  member_id: string;
  manager_member_id: string;
  kind: ReportingKind;
  created_at: Timestamp;
}

export interface AuditLogsTable {
  id: Generated<string>;
  org_id: string | null;
  occurred_at: Timestamp;
  actor_type: 'member' | 'system';
  actor_member_id: string | null;
  on_behalf_of_member_id: string | null;
  task_id: string | null;
  execution_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: 'success' | 'denied' | 'failure';
  request_id: string | null;
  details: Json<Record<string, unknown>>;
  details_hash: string;
  details_uri: string | null;
}

export interface OutboxEventsTable {
  id: Generated<string>;
  org_id: string | null;
  type: string;
  version: Generated<number>;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: Generated<number>;
  data: Json<Record<string, unknown>>;
  request_id: string | null;
  created_at: Timestamp;
  attempts: Generated<number>;
  next_attempt_at: Timestamp | null;
  dead: Generated<boolean>;
}

export interface Database {
  'workforce.organizations': OrganizationsTable;
  'workforce.members': MembersTable;
  'workforce.org_units': OrgUnitsTable;
  'workforce.reporting_lines': ReportingLinesTable;
  'workforce.ai_profiles': AiProfilesTable;
  'platform.audit_logs': AuditLogsTable;
  'platform.outbox_events': OutboxEventsTable;
}

export type Organization = Selectable<OrganizationsTable>;
export type NewOrganization = Insertable<OrganizationsTable>;
export type OrganizationUpdate = Updateable<OrganizationsTable>;
export type Member = Selectable<MembersTable>;
export type NewMember = Insertable<MembersTable>;
export type AuditLog = Selectable<AuditLogsTable>;
export type OrgUnit = Selectable<OrgUnitsTable>;
export type ReportingLine = Selectable<ReportingLinesTable>;
export type AiProfile = Selectable<AiProfilesTable>;
