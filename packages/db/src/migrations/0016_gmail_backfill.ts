import { sql, type Kysely } from 'kysely';

/**
 * Gmail: read mail that arrived between linking the account and the watch starting.
 * backfill_after is set when a watch starts for a newly linked account; the next sync reads
 * inbox mail received after it, then clears it. Mail from before the link is never read.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table conversations.gmail_mailboxes add column backfill_after timestamptz`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table conversations.gmail_mailboxes drop column if exists backfill_after`.execute(
    db,
  );
}
