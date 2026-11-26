import { sql, type Kysely } from 'kysely';

/**
 * Phase 2, slice 3: messages an AI employee receives, and what it decided to do with each.
 * - conversations.inbound_messages: one row per Chat message or email, stored once even when
 *   the provider delivers it twice (unique on employee, source and the provider's id).
 * - conversations.message_decisions: the addressing facts code worked out, the model's
 *   classification and the final action, so every decision can be explained and measured.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table conversations.inbound_messages (
      id uuid primary key default uuidv7(),
      org_id uuid not null,
      employee_id uuid not null,
      source text not null check (source in ('google_chat', 'gmail', 'simulated')),
      external_id text not null check (length(external_id) between 1 and 512),
      thread_key text check (thread_key is null or length(thread_key) <= 512),
      space_name text check (space_name is null or length(space_name) <= 512),
      space_type text check (space_type in ('direct', 'group', 'space', 'email')),
      sender_email text check (sender_email is null or length(sender_email) <= 254),
      sender_name text check (sender_name is null or length(sender_name) <= 200),
      sender_member_id uuid,
      subject text check (subject is null or length(subject) <= 1000),
      body text not null check (length(body) <= 100000),
      mentions text[] not null default '{}',
      to_addresses text[] not null default '{}',
      cc_addresses text[] not null default '{}',
      sent_at timestamptz not null,
      received_at timestamptz not null default now(),
      status text not null default 'received'
        check (status in ('received', 'processing', 'decided', 'failed')),
      last_error text check (last_error is null or length(last_error) <= 2000),
      foreign key (org_id, employee_id) references workforce.members (org_id, id)
    )
  `.execute(db);
  await sql`
    create unique index inbound_messages_external_uq
      on conversations.inbound_messages (employee_id, source, external_id)
  `.execute(db);
  await sql`
    create index inbound_messages_inbox_idx
      on conversations.inbound_messages (org_id, employee_id, id desc)
  `.execute(db);
  await sql`
    create index inbound_messages_thread_idx
      on conversations.inbound_messages (org_id, employee_id, thread_key)
  `.execute(db);

  await sql`
    create table conversations.message_decisions (
      id uuid primary key default uuidv7(),
      org_id uuid not null,
      message_id uuid not null references conversations.inbound_messages (id),
      facts jsonb not null,
      classification jsonb,
      action text not null
        check (action in ('ignore', 'remember', 'reply', 'acknowledge', 'decline', 'needs_review')),
      reasons text[] not null default '{}',
      needs text[] not null default '{}',
      model text,
      prompt_version text,
      latency_ms integer,
      input_tokens integer,
      output_tokens integer,
      error_code text,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index message_decisions_message_idx on conversations.message_decisions (org_id, message_id)`.execute(
    db,
  );

  for (const table of ['conversations.inbound_messages', 'conversations.message_decisions']) {
    await sql`alter table ${sql.raw(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.raw(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.raw(table)}
        using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())
    `.execute(db);
  }
  await sql`grant usage on schema conversations to aiw_app`.execute(db);
  await sql`grant select, insert, update on conversations.inbound_messages to aiw_app`.execute(db);
  await sql`grant select, insert on conversations.message_decisions to aiw_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists conversations.message_decisions`.execute(db);
  await sql`drop table if exists conversations.inbound_messages`.execute(db);
}
