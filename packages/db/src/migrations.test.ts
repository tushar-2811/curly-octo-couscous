import { createLogger } from '@aiw/logger';
import { sql, type Kysely } from 'kysely';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { MODULE_SCHEMAS } from './migrations/0001_foundation';
import { createMigrator } from './migrator';

/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI and local dev);
 * skipped otherwise. Proves every migration applies, reverts and re-applies cleanly.
 */
const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe.skipIf(!url)('migrations', () => {
  const db = (
    url ? createDb({ connectionString: url, logger: silent }) : undefined
  ) as Kysely<unknown>;
  afterAll(async () => db?.destroy());

  it('apply, revert and re-apply cleanly', async () => {
    await sql`create schema if not exists platform`.execute(db);
    const migrator = createMigrator(db);

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    let down = await migrator.migrateDown();
    while (!down.error && down.results?.length) down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();

    const again = await migrator.migrateToLatest();
    expect(again.error).toBeUndefined();

    const rows = await sql<{ nspname: string }>`select nspname from pg_namespace`.execute(db);
    const names = rows.rows.map((r) => r.nspname);
    for (const schema of MODULE_SCHEMAS) expect(names).toContain(schema);
  });
});
