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
  created_at: Timestamp;
  updated_at: Timestamp;
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
  'platform.audit_logs': AuditLogsTable;
  'platform.outbox_events': OutboxEventsTable;
}

export type Organization = Selectable<OrganizationsTable>;
export type NewOrganization = Insertable<OrganizationsTable>;
export type OrganizationUpdate = Updateable<OrganizationsTable>;
export type Member = Selectable<MembersTable>;
export type NewMember = Insertable<MembersTable>;
export type AuditLog = Selectable<AuditLogsTable>;
