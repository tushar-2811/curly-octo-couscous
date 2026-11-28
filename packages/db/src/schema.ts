import type {
  ColumnType,
  Generated,
  GeneratedAlways,
  Insertable,
  Selectable,
  Updateable,
} from 'kysely';

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

export type IdentityProvider = 'google_workspace';
export type AuthenticationStatus = 'unverified' | 'verified' | 'failed';
export type ConnectionStatus =
  'pending' | 'connected' | 'reauth_required' | 'revoked' | 'disconnected';

/** An account an employee uses, e.g. its company Google account (Identity linking §3). */
export interface ExternalIdentitiesTable {
  id: Generated<string>;
  org_id: string;
  member_id: string;
  provider: IdentityProvider;
  /** Google's stable `sub`, never the email. */
  provider_user_id: string;
  email_address: string;
  hosted_domain: string | null;
  authentication_status: Generated<AuthenticationStatus>;
  granted_scopes: ColumnType<string[], string[] | undefined, string[]>;
  connection_status: Generated<ConnectionStatus>;
  is_primary: Generated<boolean>;
  credential_ref: string | null;
  last_verified_at: Timestamp | null;
  last_error: string | null;
  connected_at: Timestamp;
  disconnected_at: Timestamp | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** A pending OAuth sign-in. Single use, expires after 10 minutes. */
export interface OauthLinkRequestsTable {
  state_hash: string;
  org_id: string;
  member_id: string;
  provider: IdentityProvider;
  expected_email: string;
  nonce_hash: string;
  /** Encrypted. */
  pkce_verifier: string;
  requested_scopes: string[];
  created_by: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
}

/** Encrypted secret values such as refresh tokens. Never returned by the API. */
export interface SecretsTable {
  id: Generated<string>;
  org_id: string;
  purpose: string;
  ciphertext: string;
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

export type MessageSource = 'google_chat' | 'gmail' | 'simulated';
export type SpaceType = 'direct' | 'group' | 'space' | 'email';
export type MessageStatus = 'received' | 'processing' | 'decided' | 'failed';
export type DecisionAction =
  'ignore' | 'remember' | 'reply' | 'acknowledge' | 'decline' | 'needs_review';

/** A Chat message or email an AI employee received (Phase 2). Stored once per provider id. */
export interface InboundMessagesTable {
  id: Generated<string>;
  org_id: string;
  employee_id: string;
  source: MessageSource;
  external_id: string;
  thread_key: string | null;
  space_name: string | null;
  space_type: SpaceType | null;
  sender_email: string | null;
  sender_name: string | null;
  sender_member_id: string | null;
  subject: string | null;
  body: string;
  mentions: ColumnType<string[], string[] | undefined, string[]>;
  to_addresses: ColumnType<string[], string[] | undefined, string[]>;
  cc_addresses: ColumnType<string[], string[] | undefined, string[]>;
  sent_at: Timestamp;
  received_at: Timestamp;
  status: Generated<MessageStatus>;
  last_error: string | null;
  /** Generated: thread, else space, else the direct chat with the sender. */
  conversation_key: GeneratedAlways<string>;
  /** Chat thread to reply in (Chat's resource name). */
  reply_thread: ColumnType<string | null, string | null | undefined, string | null>;
  space_display_name: ColumnType<string | null, string | null | undefined, string | null>;
  /** Email only: the Message-ID and References headers, for threading a reply. */
  email_message_id: ColumnType<string | null, string | null | undefined, string | null>;
  email_references: ColumnType<string | null, string | null | undefined, string | null>;
}

/** What the employee decided to do with a message, and why. */
export interface MessageDecisionsTable {
  id: Generated<string>;
  org_id: string;
  message_id: string;
  facts: Json<Record<string, unknown>>;
  classification: Json<Record<string, unknown>> | null;
  action: DecisionAction;
  reasons: ColumnType<string[], string[] | undefined, string[]>;
  needs: ColumnType<string[], string[] | undefined, string[]>;
  model: string | null;
  prompt_version: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error_code: string | null;
  created_at: Timestamp;
}

export type MemoryKind =
  | 'message'
  | 'decision'
  | 'action_item'
  | 'requirement'
  | 'technical_fact'
  | 'person_fact'
  | 'summary';
export type MemoryScope = 'direct' | 'space' | 'org';

/** Something an AI employee knows, tied to its source and to who could see the source. */
export interface MemoryItemsTable {
  id: Generated<string>;
  org_id: string;
  employee_id: string;
  kind: MemoryKind;
  content: string;
  source_type: 'inbound_message' | 'outbound_message';
  source_id: string;
  scope: MemoryScope;
  space_name: string | null;
  audience: ColumnType<string[], string[] | undefined, string[]>;
  author_member_id: string | null;
  occurred_at: Timestamp;
  /** pgvector text form, "[0.1,0.2,…]". Null until embedded. */
  embedding: string | null;
  embedding_model: string | null;
  conversation_key: string | null;
  confidence: Generated<number>;
  status: Generated<'active' | 'superseded' | 'deleted'>;
  created_at: Timestamp;
}

export interface SpaceMembersTable {
  org_id: string;
  employee_id: string;
  space_name: string;
  member_id: string;
  last_seen_at: Timestamp;
}

export interface MemorySourcesTable {
  org_id: string;
  memory_id: string;
  message_id: string;
}

/** How far fact extraction has read a conversation. */
export interface ConversationDigestsTable {
  org_id: string;
  employee_id: string;
  conversation_key: string;
  last_message_id: string;
  runs: Generated<number>;
  facts_added: Generated<number>;
  last_run_at: Timestamp;
  last_error: string | null;
}

export type OutboundStatus = 'draft' | 'queued' | 'sent' | 'failed';

/** A reply or "looking into it" note from an AI employee. */
export interface OutboundMessagesTable {
  id: Generated<string>;
  org_id: string;
  employee_id: string;
  in_reply_to: string;
  kind: 'reply' | 'ack';
  body: string;
  status: Generated<OutboundStatus>;
  answered: 'yes' | 'partly' | 'no' | null;
  sources: Json<{ memory_id: string; snippet: string }[]>;
  model: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error_code: string | null;
  created_at: Timestamp;
  sent_at: Timestamp | null;
  /** The Chat message created for it. */
  external_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** An employee's Workspace Events subscription to its Chat messages. */
export interface ChatSubscriptionsTable {
  id: Generated<string>;
  org_id: string;
  employee_id: string;
  subscription_name: string;
  target_resource: string;
  state: Generated<'active' | 'suspended' | 'deleted'>;
  expire_time: Timestamp | null;
  last_event_at: Timestamp | null;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** An employee's Gmail watch and how far its mailbox history has been read. */
export interface GmailMailboxesTable {
  id: Generated<string>;
  org_id: string;
  employee_id: string;
  email_address: string;
  /** Gmail history id (int8; read as a string). */
  history_id: ColumnType<string | null, string | null | undefined, string | null>;
  watch_expiration: Timestamp | null;
  watched_at: Timestamp | null;
  /** Read inbox mail received after this on the next sync (set when a watch starts). */
  backfill_after: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_event_at: Timestamp | null;
  last_synced_at: Timestamp | null;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Database {
  'workforce.organizations': OrganizationsTable;
  'workforce.members': MembersTable;
  'workforce.org_units': OrgUnitsTable;
  'workforce.reporting_lines': ReportingLinesTable;
  'workforce.ai_profiles': AiProfilesTable;
  'workforce.external_identities': ExternalIdentitiesTable;
  'workforce.oauth_link_requests': OauthLinkRequestsTable;
  'platform.secrets': SecretsTable;
  'conversations.inbound_messages': InboundMessagesTable;
  'conversations.message_decisions': MessageDecisionsTable;
  'conversations.outbound_messages': OutboundMessagesTable;
  'conversations.chat_subscriptions': ChatSubscriptionsTable;
  'conversations.gmail_mailboxes': GmailMailboxesTable;
  'knowledge.memory_items': MemoryItemsTable;
  'knowledge.space_members': SpaceMembersTable;
  'knowledge.memory_sources': MemorySourcesTable;
  'knowledge.conversation_digests': ConversationDigestsTable;
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
export type ExternalIdentity = Selectable<ExternalIdentitiesTable>;
export type OauthLinkRequest = Selectable<OauthLinkRequestsTable>;
export type InboundMessage = Selectable<InboundMessagesTable>;
export type MessageDecision = Selectable<MessageDecisionsTable>;
export type MemoryItem = Selectable<MemoryItemsTable>;
export type OutboundMessage = Selectable<OutboundMessagesTable>;
export type ChatSubscription = Selectable<ChatSubscriptionsTable>;
export type GmailMailbox = Selectable<GmailMailboxesTable>;
