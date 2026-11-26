import { sql, type Kysely } from 'kysely';

/**
 * Domain verification is not planned: linking an AI employee's account already
 * requires a Google sign-in whose Workspace domain (hd) matches the organization.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workforce.organizations
      drop column if exists domain_verification_token,
      drop column if exists domain_verified_at
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workforce.organizations
      add column if not exists domain_verification_token text not null default '',
      add column if not exists domain_verified_at timestamptz
  `.execute(db);
}
