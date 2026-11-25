import { sql, type Kysely } from 'kysely';

/**
 * Phase 1, slice 4: access grants (Technical architecture §9, §11; PRD SEC-1 to SEC-3).
 * - access.resources: the registry of things that can be granted. Entered by admins for
 *   now; connections (Phase 2) will discover them and fill connection_id.
 * - access.grants: one table for all of an AI employee's access. resource_id null means
 *   every resource of that type, optionally narrowed by tags. Deny rows override allows.
 *   Grants are revoked, never deleted, so the history stays readable.
 */
export const RESOURCE_TYPES = ['repo', 'jira_project', 'chat_space', 'figma_file'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  const types = sql.join(RESOURCE_TYPES.map((t) => sql.lit(t)));
  await sql`
    create table access.resources (
      id uuid primary key default uuidv7(),
      org_id uuid not null references workforce.organizations (id),
      connection_id uuid,
      type text not null check (type in (${types})),
      external_id text not null check (length(external_id) between 1 and 300),
      name text not null check (length(name) between 1 and 120),
      url text check (url is null or length(url) <= 2000),
      tags text[] not null default '{}' check (cardinality(tags) <= 20),
      created_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      archived_at timestamptz,
      unique (org_id, id)
    )
  `.execute(db);
  await sql`
    create unique index resources_external_uq on access.resources (org_id, type, lower(external_id))
      where archived_at is null
  `.execute(db);

  await sql`
    create table access.grants (
      id uuid primary key default uuidv7(),
      org_id uuid not null,
      member_id uuid not null,
      resource_type text not null check (resource_type in (${types})),
      resource_id uuid,
      effect text not null check (effect in ('allow', 'deny')),
      level text not null check (level in ('read', 'write', 'admin')),
      conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
      granted_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      revoked_at timestamptz,
      revoked_by uuid,
      revoke_reason text check (revoke_reason is null or length(revoke_reason) <= 64),
      foreign key (org_id, member_id) references workforce.members (org_id, id),
      foreign key (org_id, resource_id) references access.resources (org_id, id)
    )
  `.execute(db);
  // One live grant per employee and target; "every repo" counts as one target.
  await sql`
    create unique index grants_active_uq on access.grants (member_id, resource_type, resource_id)
      nulls not distinct where revoked_at is null
  `.execute(db);
  await sql`create index grants_member_idx on access.grants (org_id, member_id) where revoked_at is null`.execute(
    db,
  );
  await sql`create index grants_resource_idx on access.grants (org_id, resource_id) where revoked_at is null`.execute(
    db,
  );

  for (const table of ['access.resources', 'access.grants']) {
    await sql.raw(`alter table ${table} enable row level security`).execute(db);
    await sql.raw(`alter table ${table} force row level security`).execute(db);
    await sql
      .raw(
        `create policy tenant_isolation on ${table} using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())`,
      )
      .execute(db);
  }
  await sql`grant usage on schema access to aiw_app`.execute(db);
  // No delete: resources are archived and grants revoked, so history stays intact.
  await sql`grant select, insert, update on access.resources, access.grants to aiw_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists access.grants`.execute(db);
  await sql`drop table if exists access.resources`.execute(db);
  await sql`revoke usage on schema access from aiw_app`.execute(db);
}
