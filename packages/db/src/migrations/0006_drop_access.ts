import { sql, type Kysely } from 'kysely';

/**
 * Remove the slice 4 access registry and grants. AI employees get access the way
 * people do: IT creates the account and managers add it to spaces, projects and
 * repositories in each tool. 0005 stays so existing databases keep a consistent history.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists access.grants`.execute(db);
  await sql`drop table if exists access.resources`.execute(db);
}

export async function down(): Promise<void> {
  // The tables are not recreated; roll back 0005 as well to return to before slice 4.
}
