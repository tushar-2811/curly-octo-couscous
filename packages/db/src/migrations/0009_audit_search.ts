import { sql, type Kysely } from 'kysely';

/**
 * Phase 1, slice 7: audit log viewer. The viewer pages newest-first by id (UUIDv7) and
 * filters by the item changed or the person who changed it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create index audit_logs_org_id_idx on platform.audit_logs (org_id, id desc)`.execute(
    db,
  );
  await sql`create index audit_logs_org_resource_idx on platform.audit_logs (org_id, resource_id, id desc)`.execute(
    db,
  );
  await sql`create index audit_logs_org_actor_idx on platform.audit_logs (org_id, actor_member_id, id desc)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists platform.audit_logs_org_actor_idx`.execute(db);
  await sql`drop index if exists platform.audit_logs_org_resource_idx`.execute(db);
  await sql`drop index if exists platform.audit_logs_org_id_idx`.execute(db);
}
