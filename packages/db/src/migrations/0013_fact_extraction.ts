import { sql, type Kysely } from 'kysely';

/**
 * Phase 2: fact extraction. After a conversation goes quiet, the worker pulls durable
 * facts (decisions, action items, requirements, technical and people facts) out of it.
 * - inbound_messages.conversation_key: which conversation a message belongs to: its thread,
 *   else its space, else the direct chat with its sender.
 * - memory_items.conversation_key: the same, so facts keep the conversation's visibility.
 * - knowledge.memory_sources: the messages each fact came from.
 * - knowledge.conversation_digests: how far extraction has read each conversation.
 * - app.conversations_to_digest: quiet conversations with unread messages, across
 *   organizations, for the worker's sweep (ids only).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table conversations.inbound_messages add column conversation_key text
      generated always as (
        case
          when thread_key is not null then 'thread:' || thread_key
          when space_type = 'direct' then 'dm:' || coalesce(sender_member_id::text, sender_email, 'unknown')
          when space_type = 'email' then 'email:' || coalesce(sender_member_id::text, sender_email, 'unknown')
          else 'space:' || coalesce(space_name, 'unknown')
        end
      ) stored
  `.execute(db);
  await sql`
    create index inbound_messages_conversation_idx
      on conversations.inbound_messages (employee_id, conversation_key, id)
  `.execute(db);

  await sql`alter table knowledge.memory_items add column conversation_key text`.execute(db);
  await sql`
    update knowledge.memory_items mi set conversation_key = m.conversation_key
    from conversations.inbound_messages m
    where mi.source_type = 'inbound_message' and mi.source_id = m.id
  `.execute(db);
  await sql`
    create index memory_items_conversation_idx
      on knowledge.memory_items (employee_id, conversation_key, id)
      where kind <> 'message'
  `.execute(db);

  await sql`
    create table knowledge.memory_sources (
      org_id uuid not null,
      memory_id uuid not null references knowledge.memory_items (id),
      message_id uuid not null references conversations.inbound_messages (id),
      primary key (memory_id, message_id)
    )
  `.execute(db);

  await sql`
    create table knowledge.conversation_digests (
      org_id uuid not null,
      employee_id uuid not null,
      conversation_key text not null,
      last_message_id uuid not null,
      runs integer not null default 0,
      facts_added integer not null default 0,
      last_run_at timestamptz not null default now(),
      last_error text check (last_error is null or length(last_error) <= 2000),
      primary key (employee_id, conversation_key),
      foreign key (org_id, employee_id) references workforce.members (org_id, id)
    )
  `.execute(db);

  for (const table of ['knowledge.memory_sources', 'knowledge.conversation_digests']) {
    await sql`alter table ${sql.raw(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.raw(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.raw(table)}
        using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())
    `.execute(db);
  }
  await sql`grant select, insert on knowledge.memory_sources to aiw_app`.execute(db);
  await sql`grant select, insert, update on knowledge.conversation_digests to aiw_app`.execute(db);

  // Conversations with remembered messages extraction has not read, quiet for p_quiet seconds.
  await sql`
    create function app.conversations_to_digest(p_quiet integer, p_max integer)
    returns table (org_id uuid, employee_id uuid, conversation_key text, last_message_id uuid)
    language sql stable security definer set search_path = pg_catalog, conversations, knowledge
    as $$
      select m.org_id, m.employee_id, m.conversation_key, max(m.id::text)::uuid
      from conversations.inbound_messages m
      join knowledge.memory_items mi
        on mi.source_type = 'inbound_message' and mi.source_id = m.id and mi.kind = 'message'
      left join knowledge.conversation_digests d
        on d.employee_id = m.employee_id and d.conversation_key = m.conversation_key
      where m.received_at > now() - interval '7 days'
        and (d.last_message_id is null or m.id > d.last_message_id)
      group by m.org_id, m.employee_id, m.conversation_key
      having max(m.received_at) < now() - make_interval(secs => greatest(p_quiet, 0))
      limit least(greatest(p_max, 1), 200)
    $$
  `.execute(db);
  await sql`revoke all on function app.conversations_to_digest(integer, integer) from public`.execute(
    db,
  );
  await sql`grant execute on function app.conversations_to_digest(integer, integer) to aiw_app`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists app.conversations_to_digest(integer, integer)`.execute(db);
  await sql`drop table if exists knowledge.conversation_digests`.execute(db);
  await sql`drop table if exists knowledge.memory_sources`.execute(db);
  await sql`drop index if exists knowledge.memory_items_conversation_idx`.execute(db);
  await sql`alter table knowledge.memory_items drop column if exists conversation_key`.execute(db);
  await sql`drop index if exists conversations.inbound_messages_conversation_idx`.execute(db);
  await sql`alter table conversations.inbound_messages drop column if exists conversation_key`.execute(
    db,
  );
}
