import { sql, type Kysely } from 'kysely';

/**
 * Phase 2: Google Chat intake and sending.
 * - inbound_messages.reply_thread: the Chat thread to answer in; space_display_name: the
 *   space's name for people (space_name keeps the stable resource name, used for privacy).
 * - outbound_messages.external_id: the Chat message created for a reply.
 * - conversations.chat_subscriptions: each employee's Workspace Events subscription.
 * - app.chat_subscription_owner / app.chat_employees: cross-tenant lookups for the worker
 *   (ids only): which employee an event belongs to, and who should be listening.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table conversations.inbound_messages add column reply_thread text`.execute(db);
  await sql`alter table conversations.inbound_messages add column space_display_name text`.execute(
    db,
  );
  await sql`alter table conversations.outbound_messages add column external_id text`.execute(db);

  await sql`
    create table conversations.chat_subscriptions (
      id uuid primary key default uuidv7(),
      org_id uuid not null,
      employee_id uuid not null,
      subscription_name text not null unique,
      target_resource text not null,
      state text not null default 'active' check (state in ('active', 'suspended', 'deleted')),
      expire_time timestamptz,
      last_event_at timestamptz,
      last_error text check (last_error is null or length(last_error) <= 2000),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      foreign key (org_id, employee_id) references workforce.members (org_id, id)
    )
  `.execute(db);
  await sql`
    create unique index chat_subscriptions_employee_uq
      on conversations.chat_subscriptions (employee_id, target_resource) where state <> 'deleted'
  `.execute(db);
  await sql`alter table conversations.chat_subscriptions enable row level security`.execute(db);
  await sql`alter table conversations.chat_subscriptions force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on conversations.chat_subscriptions
      using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())
  `.execute(db);
  await sql`grant select, insert, update on conversations.chat_subscriptions to aiw_app`.execute(
    db,
  );

  await sql`
    create function app.chat_subscription_owner(p_name text)
    returns table (org_id uuid, employee_id uuid)
    language sql stable security definer set search_path = pg_catalog, conversations
    as $$
      select org_id, employee_id from conversations.chat_subscriptions
      where subscription_name = p_name and state <> 'deleted'
    $$
  `.execute(db);
  // AI employees whose linked Google account granted Chat access and who are not stopped.
  await sql`
    create function app.chat_employees()
    returns table (org_id uuid, employee_id uuid)
    language sql stable security definer set search_path = pg_catalog, workforce
    as $$
      select i.org_id, i.member_id
      from workforce.external_identities i
      join workforce.members m on m.id = i.member_id and m.type = 'ai'
      where i.provider = 'google_workspace'
        and i.connection_status = 'connected'
        and 'https://www.googleapis.com/auth/chat.messages.readonly' = any (i.granted_scopes)
        and m.status not in ('suspended', 'terminated')
      order by i.connected_at
    $$
  `.execute(db);
  for (const fn of ['app.chat_subscription_owner(text)', 'app.chat_employees()']) {
    await sql`revoke all on function ${sql.raw(fn)} from public`.execute(db);
    await sql`grant execute on function ${sql.raw(fn)} to aiw_app`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists app.chat_employees()`.execute(db);
  await sql`drop function if exists app.chat_subscription_owner(text)`.execute(db);
  await sql`drop table if exists conversations.chat_subscriptions`.execute(db);
  await sql`alter table conversations.outbound_messages drop column if exists external_id`.execute(
    db,
  );
  await sql`alter table conversations.inbound_messages drop column if exists space_display_name`.execute(
    db,
  );
  await sql`alter table conversations.inbound_messages drop column if exists reply_thread`.execute(
    db,
  );
}
