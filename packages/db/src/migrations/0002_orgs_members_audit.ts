import { sql, type Kysely } from 'kysely';

/**
 * Phase 1, slice 1: organizations, members, audit log and outbox.
 *
 * Tenancy: every tenant table has org_id and a row-level security policy
 * `org_id = app.current_org_id()`. The application switches to the non-superuser role
 * `aiw_app` inside each tenant transaction (SET LOCAL ROLE), so the policies apply even
 * though the connection itself may be a superuser in local development.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'aiw_app') then
        create role aiw_app nologin;
      end if;
    end $$;
  `.execute(db);
  // Let the connecting user switch to aiw_app.
  await sql`grant aiw_app to current_user`.execute(db);

  // ---------- workforce.organizations ----------
  await sql`
    create table workforce.organizations (
      id uuid primary key default uuidv7(),
      name text not null check (length(name) between 2 and 120),
      slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
      domain text not null unique check (domain = lower(domain)),
      domain_verification_token text not null,
      domain_verified_at timestamptz,
      google_customer_id text,
      status text not null default 'active' check (status in ('active', 'suspended')),
      data_region text not null default 'us',
      settings jsonb not null default '{"schema":"org_settings@1","revision":0,"value":{}}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);

  // ---------- workforce.members (humans and AI employees) ----------
  await sql`
    create table workforce.members (
      id uuid primary key default uuidv7(),
      org_id uuid not null references workforce.organizations (id),
      type text not null check (type in ('human', 'ai')),
      display_name text not null check (length(display_name) between 1 and 120),
      email text check (email is null or email = lower(email)),
      title text,
      person_role text check (person_role in ('admin', 'security_admin', 'manager', 'member')),
      auth_subject text unique,
      status text not null default 'active',
      onboarding_checks jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (org_id, id),
      check (type = 'ai' or person_role is not null)
    )
  `.execute(db);
  await sql`create unique index members_org_email_uq on workforce.members (org_id, email) where email is not null`.execute(
    db,
  );
  await sql`create index members_org_type_status_idx on workforce.members (org_id, type, status)`.execute(
    db,
  );

  // ---------- platform.audit_logs (append-only) ----------
  await sql`
    create table platform.audit_logs (
      id uuid primary key default uuidv7(),
      org_id uuid references workforce.organizations (id),
      occurred_at timestamptz not null default now(),
      actor_type text not null check (actor_type in ('member', 'system')),
      actor_member_id uuid,
      on_behalf_of_member_id uuid,
      task_id uuid,
      execution_id uuid,
      action text not null,
      resource_type text not null,
      resource_id text,
      outcome text not null check (outcome in ('success', 'denied', 'failure')),
      request_id text,
      details jsonb not null default '{}'::jsonb,
      details_hash text not null,
      details_uri text
    )
  `.execute(db);
  await sql`create index audit_logs_org_time_idx on platform.audit_logs (org_id, occurred_at desc)`.execute(
    db,
  );
  await sql`
    create function platform.forbid_change() returns trigger language plpgsql as $$
    begin
      raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
    end $$
  `.execute(db);
  await sql`
    create trigger audit_logs_append_only before update or delete on platform.audit_logs
    for each row execute function platform.forbid_change()
  `.execute(db);

  // ---------- platform.outbox_events ----------
  await sql`
    create table platform.outbox_events (
      id uuid primary key default uuidv7(),
      org_id uuid references workforce.organizations (id),
      type text not null,
      version int not null default 1,
      aggregate_type text not null,
      aggregate_id text not null,
      aggregate_version int not null default 1,
      data jsonb not null default '{}'::jsonb,
      request_id text,
      created_at timestamptz not null default now(),
      attempts int not null default 0,
      next_attempt_at timestamptz,
      dead boolean not null default false
    )
  `.execute(db);
  await sql`create index outbox_pending_idx on platform.outbox_events (created_at) where not dead`.execute(
    db,
  );

  // ---------- row-level security ----------
  for (const [table, column] of [
    ['workforce.organizations', 'id'],
    ['workforce.members', 'org_id'],
    ['platform.audit_logs', 'org_id'],
    ['platform.outbox_events', 'org_id'],
  ] as const) {
    await sql.raw(`alter table ${table} enable row level security`).execute(db);
    await sql.raw(`alter table ${table} force row level security`).execute(db);
    await sql
      .raw(
        `create policy tenant_isolation on ${table} using (${column} = app.current_org_id()) with check (${column} = app.current_org_id())`,
      )
      .execute(db);
  }

  // The one lookup that must cross tenants: "which member is this signed-in person?".
  // SECURITY DEFINER runs it with the owner's rights; it returns ids only.
  await sql`
    create function app.member_for_subject(p_subject text)
    returns table (member_id uuid, org_id uuid, status text)
    language sql stable security definer set search_path = pg_catalog, workforce
    as $$ select id, org_id, status from workforce.members where auth_subject = p_subject $$
  `.execute(db);
  await sql`revoke all on function app.member_for_subject(text) from public`.execute(db);
  await sql`grant execute on function app.member_for_subject(text) to aiw_app`.execute(db);

  await sql`grant usage on schema app, workforce, platform to aiw_app`.execute(db);
  await sql`grant execute on function app.current_org_id() to aiw_app`.execute(db);
  await sql`grant select, insert, update on workforce.organizations, workforce.members to aiw_app`.execute(
    db,
  );
  await sql`grant select, insert on platform.audit_logs, platform.outbox_events to aiw_app`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists platform.outbox_events`.execute(db);
  await sql`drop table if exists platform.audit_logs`.execute(db);
  await sql`drop function if exists platform.forbid_change()`.execute(db);
  await sql`drop function if exists app.member_for_subject(text)`.execute(db);
  await sql`drop table if exists workforce.members`.execute(db);
  await sql`drop table if exists workforce.organizations`.execute(db);
  await sql`revoke all on schema app, workforce, platform from aiw_app`.execute(db);
  await sql`revoke execute on function app.current_org_id() from aiw_app`.execute(db);
}
