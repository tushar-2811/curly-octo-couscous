import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './schema';

export type Tx = Transaction<Database>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in a transaction scoped to one organization. Row-level security applies:
 * queries can only see and write rows whose org_id is `orgId`, whatever the SQL says.
 * Every application query runs through this (or `asApp`).
 */
export async function withTenant<T>(
  db: Kysely<Database>,
  orgId: string,
  fn: (trx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(orgId)) throw new Error('withTenant: orgId must be a UUID');
  return db.transaction().execute(async (trx) => {
    await sql`set local role aiw_app`.execute(trx);
    await sql`select set_config('app.org_id', ${orgId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * Run `fn` as the application role with no organization selected: tenant tables are
 * invisible. Used only for the cross-tenant lookup functions in the `app` schema.
 */
export async function asApp<T>(db: Kysely<Database>, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`set local role aiw_app`.execute(trx);
    return fn(trx);
  });
}

/** A new UUIDv7 from Postgres, for ids that must be known before the first insert. */
export async function newId(db: Kysely<Database>): Promise<string> {
  const result = await sql<{ id: string }>`select uuidv7() as id`.execute(db);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('uuidv7() returned no id');
  return id;
}

/** Who is this signed-in person? Returns ids only; no other tenant data crosses over. */
export async function memberForSubject(
  db: Kysely<Database>,
  subject: string,
): Promise<{ member_id: string; org_id: string; status: string } | undefined> {
  return asApp(db, async (trx) => {
    const result = await sql<{ member_id: string; org_id: string; status: string }>`
      select member_id, org_id, status from app.member_for_subject(${subject})
    `.execute(trx);
    return result.rows[0];
  });
}
