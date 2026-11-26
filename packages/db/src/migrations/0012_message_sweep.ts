import { sql, type Kysely } from 'kysely';

/**
 * Phase 2: messages are processed by a workflow in the worker. The worker's sweep finds
 * messages that never got one (the web process stopped before starting it) and failed
 * ones worth another try, across all organizations. SECURITY DEFINER: it returns ids only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create index inbound_messages_pending_idx
      on conversations.inbound_messages (received_at)
      where status <> 'decided'
  `.execute(db);
  await sql`
    create function app.stale_inbound_messages(p_max integer)
    returns table (org_id uuid, message_id uuid)
    language sql stable security definer set search_path = pg_catalog, conversations
    as $$
      select m.org_id, m.id
      from conversations.inbound_messages m
      where m.status <> 'decided'
        and m.received_at < now() - interval '2 minutes'
        and m.received_at > now() - interval '1 day'
        and (select count(*) from conversations.message_decisions d where d.message_id = m.id) < 12
      order by m.received_at
      limit least(greatest(p_max, 1), 500)
    $$
  `.execute(db);
  await sql`revoke all on function app.stale_inbound_messages(integer) from public`.execute(db);
  await sql`grant execute on function app.stale_inbound_messages(integer) to aiw_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists app.stale_inbound_messages(integer)`.execute(db);
  await sql`drop index if exists conversations.inbound_messages_pending_idx`.execute(db);
}
