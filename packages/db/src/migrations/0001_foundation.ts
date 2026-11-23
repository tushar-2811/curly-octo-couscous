import { sql, type Kysely } from 'kysely';

/** One Postgres schema per module (Technical architecture §2). */
export const MODULE_SCHEMAS = [
  'workforce',
  'access',
  'conversations',
  'work',
  'orchestration',
  'execution',
  'knowledge',
  'platform',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const schema of MODULE_SCHEMAS) {
    await db.schema.createSchema(schema).ifNotExists().execute();
  }

  // Shared helpers. Row-level security policies call app.current_org_id(), which reads
  // the org id the application sets per transaction with set_config('app.org_id', ...).
  await db.schema.createSchema('app').ifNotExists().execute();
  await sql`
    create or replace function app.current_org_id() returns uuid
    language sql stable
    as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists app.current_org_id()`.execute(db);
  await db.schema.dropSchema('app').ifExists().execute();
  // "platform" stays: it holds the migration bookkeeping tables themselves.
  for (const schema of [...MODULE_SCHEMAS].reverse()) {
    if (schema === 'platform') continue;
    await db.schema.dropSchema(schema).ifExists().execute();
  }
}
