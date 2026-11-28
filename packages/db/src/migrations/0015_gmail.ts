import { sql, type Kysely } from 'kysely';

/**
 * Phase 2: Gmail intake and email replies.
 * - inbound_messages.email_message_id / email_references: the RFC 5322 Message-ID and
 *   References headers, so a reply joins the same thread in every mail client.
 * - conversations.gmail_mailboxes: each employee's Gmail watch and how far its history has
 *   been read (history_id), so no message is missed between notifications.
 * - app.gmail_employees / app.gmail_mailbox_owner: cross-tenant lookups for the worker
 *   (ids only): who should be watched, and whose mailbox a notification is for.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table conversations.inbound_messages
      add column email_message_id text
        check (email_message_id is null or length(email_message_id) <= 998),
      add column email_references text
        check (email_references is null or length(email_references) <= 8000)
  `.execute(db);

  await sql`
    create table conversations.gmail_mailboxes (
      id uuid primary key default uuidv7(),
      org_id uuid not null,
      employee_id uuid not null unique,
      email_address text not null check (length(email_address) <= 254),
      history_id bigint,
      watch_expiration timestamptz,
      watched_at timestamptz,
      last_event_at timestamptz,
      last_synced_at timestamptz,
      last_error text check (last_error is null or length(last_error) <= 2000),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      foreign key (org_id, employee_id) references workforce.members (org_id, id)
    )
  `.execute(db);
  await sql`create index gmail_mailboxes_email_idx on conversations.gmail_mailboxes (lower(email_address))`.execute(
    db,
  );
  await sql`alter table conversations.gmail_mailboxes enable row level security`.execute(db);
  await sql`alter table conversations.gmail_mailboxes force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on conversations.gmail_mailboxes
      using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())
  `.execute(db);
  await sql`grant select, insert, update on conversations.gmail_mailboxes to aiw_app`.execute(db);

  await sql`
    create function app.gmail_mailbox_owner(p_email text)
    returns table (org_id uuid, employee_id uuid)
    language sql stable security definer set search_path = pg_catalog, conversations
    as $$
      select org_id, employee_id from conversations.gmail_mailboxes
      where lower(email_address) = lower(p_email)
    $$
  `.execute(db);
  // AI employees whose linked Google account granted Gmail reading and who are not stopped.
  await sql`
    create function app.gmail_employees()
    returns table (org_id uuid, employee_id uuid)
    language sql stable security definer set search_path = pg_catalog, workforce
    as $$
      select i.org_id, i.member_id
      from workforce.external_identities i
      join workforce.members m on m.id = i.member_id and m.type = 'ai'
      where i.provider = 'google_workspace'
        and i.connection_status = 'connected'
        and 'https://www.googleapis.com/auth/gmail.readonly' = any (i.granted_scopes)
        and m.status not in ('suspended', 'terminated')
      order by i.connected_at
    $$
  `.execute(db);
  for (const fn of ['app.gmail_mailbox_owner(text)', 'app.gmail_employees()']) {
    await sql`revoke all on function ${sql.raw(fn)} from public`.execute(db);
    await sql`grant execute on function ${sql.raw(fn)} to aiw_app`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists app.gmail_employees()`.execute(db);
  await sql`drop function if exists app.gmail_mailbox_owner(text)`.execute(db);
  await sql`drop table if exists conversations.gmail_mailboxes`.execute(db);
  await sql`
    alter table conversations.inbound_messages
      drop column if exists email_references,
      drop column if exists email_message_id
  `.execute(db);
}
