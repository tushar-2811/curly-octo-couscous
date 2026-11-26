import { sql, type Kysely } from 'kysely';

/**
 * Phase 2, slices 4 and 5: an AI employee's memory and the replies it drafts.
 * - knowledge.memory_items: what the employee knows, each item tied to its source.
 *   Searchable by meaning (pgvector, Voyage embeddings) and by words (full-text).
 *   `scope`, `space_name` and `audience` record who could see the source, so a search
 *   only returns what the people who will read the answer could already see.
 * - knowledge.space_members: who has been seen in which Chat space. Filled from messages
 *   now; from the Chat API's member list once Chat is connected.
 * - conversations.outbound_messages: replies and "looking into it" notes, with the
 *   memory items each reply used. Test messages only ever get drafts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists vector`.execute(db);

  await sql`
    create table knowledge.memory_items (
      id uuid primary key default uuidv7(),
      org_id uuid not null,
      employee_id uuid not null,
      kind text not null check (kind in
        ('message', 'decision', 'action_item', 'requirement', 'technical_fact', 'person_fact', 'summary')),
      content text not null check (length(content) between 1 and 8000),
      source_type text not null check (source_type in ('inbound_message', 'outbound_message')),
      source_id uuid not null,
      scope text not null check (scope in ('direct', 'space', 'org')),
      space_name text,
      audience uuid[] not null default '{}',
      author_member_id uuid,
      occurred_at timestamptz not null,
      embedding vector(1024),
      embedding_model text,
      tsv tsvector generated always as (to_tsvector('english', content)) stored,
      confidence real not null default 1 check (confidence between 0 and 1),
      status text not null default 'active' check (status in ('active', 'superseded', 'deleted')),
      created_at timestamptz not null default now(),
      foreign key (org_id, employee_id) references workforce.members (org_id, id),
      check (scope <> 'space' or space_name is not null)
    )
  `.execute(db);
  await sql`
    create unique index memory_items_source_uq
      on knowledge.memory_items (employee_id, source_type, source_id, kind)
      where kind = 'message'
  `.execute(db);
  await sql`create index memory_items_employee_idx on knowledge.memory_items (org_id, employee_id, id desc)`.execute(
    db,
  );
  await sql`create index memory_items_tsv_idx on knowledge.memory_items using gin (tsv)`.execute(
    db,
  );
  await sql`
    create index memory_items_embedding_idx
      on knowledge.memory_items using hnsw (embedding vector_cosine_ops)
  `.execute(db);

  await sql`
    create table knowledge.space_members (
      org_id uuid not null,
      employee_id uuid not null,
      space_name text not null,
      member_id uuid not null,
      last_seen_at timestamptz not null default now(),
      primary key (employee_id, space_name, member_id),
      foreign key (org_id, employee_id) references workforce.members (org_id, id),
      foreign key (org_id, member_id) references workforce.members (org_id, id)
    )
  `.execute(db);

  await sql`
    create table conversations.outbound_messages (
      id uuid primary key default uuidv7(),
      org_id uuid not null,
      employee_id uuid not null,
      in_reply_to uuid not null references conversations.inbound_messages (id),
      kind text not null check (kind in ('reply', 'ack')),
      body text not null check (length(body) between 1 and 8000),
      status text not null default 'draft' check (status in ('draft', 'queued', 'sent', 'failed')),
      answered text check (answered in ('yes', 'partly', 'no')),
      sources jsonb not null default '[]',
      model text,
      latency_ms integer,
      input_tokens integer,
      output_tokens integer,
      error_code text,
      created_at timestamptz not null default now(),
      sent_at timestamptz,
      foreign key (org_id, employee_id) references workforce.members (org_id, id)
    )
  `.execute(db);
  await sql`create index outbound_messages_reply_idx on conversations.outbound_messages (org_id, in_reply_to)`.execute(
    db,
  );

  for (const table of [
    'knowledge.memory_items',
    'knowledge.space_members',
    'conversations.outbound_messages',
  ]) {
    await sql`alter table ${sql.raw(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.raw(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.raw(table)}
        using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())
    `.execute(db);
  }
  await sql`grant usage on schema knowledge to aiw_app`.execute(db);
  await sql`grant select, insert, update on knowledge.memory_items, knowledge.space_members, conversations.outbound_messages to aiw_app`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists conversations.outbound_messages`.execute(db);
  await sql`drop table if exists knowledge.space_members`.execute(db);
  await sql`drop table if exists knowledge.memory_items`.execute(db);
}
