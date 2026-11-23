import { Writable } from 'node:stream';
import { createLogger } from '@aiw/logger';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { createMigrator } from './migrator';
import { memberForSubject, newId, withTenant } from './tenant';

/**
 * Row-level security is the guarantee that one organization can never read or write
 * another's data. These tests run against a real Postgres (TEST_DATABASE_URL).
 */
const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe.skipIf(!url)('tenant isolation', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  let orgA = '';
  let orgB = '';
  const suffix = Date.now().toString(36);

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    orgA = await newId(db);
    orgB = await newId(db);
    for (const [id, name] of [
      [orgA, 'Alpha'],
      [orgB, 'Beta'],
    ] as const) {
      await withTenant(db, id, async (trx) => {
        await trx
          .insertInto('workforce.organizations')
          .values({
            id,
            name,
            slug: `${name.toLowerCase()}-${suffix}`,
            domain: `${name.toLowerCase()}-${suffix}.test`,
            domain_verification_token: 't',
          })
          .execute();
        await trx
          .insertInto('workforce.members')
          .values({
            org_id: id,
            type: 'human',
            display_name: `${name} admin`,
            email: `admin@${name.toLowerCase()}-${suffix}.test`,
            person_role: 'admin',
            auth_subject: `test:${name}-${suffix}`,
          })
          .execute();
      });
    }
  });
  afterAll(async () => db.destroy());

  it('only shows rows of the selected organization', async () => {
    const seen = await withTenant(db, orgA, (trx) =>
      trx.selectFrom('workforce.members').select(['org_id', 'display_name']).execute(),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((m) => m.org_id === orgA)).toBe(true);
    const orgs = await withTenant(db, orgA, (trx) =>
      trx.selectFrom('workforce.organizations').select('id').execute(),
    );
    expect(orgs.map((o) => o.id)).toEqual([orgA]);
  });

  it('refuses to write a row into another organization', async () => {
    await expect(
      withTenant(db, orgA, (trx) =>
        trx
          .insertInto('workforce.members')
          .values({ org_id: orgB, type: 'ai', display_name: 'Intruder' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update another organization even by id', async () => {
    const result = await withTenant(db, orgA, (trx) =>
      trx
        .updateTable('workforce.organizations')
        .set({ name: 'Hacked' })
        .where('id', '=', orgB)
        .executeTakeFirst(),
    );
    expect(Number(result.numUpdatedRows)).toBe(0);
  });

  it('keeps the audit log append-only', async () => {
    await withTenant(db, orgA, (trx) =>
      trx
        .insertInto('platform.audit_logs')
        .values({
          org_id: orgA,
          actor_type: 'system',
          action: 'test.write',
          resource_type: 'test',
          outcome: 'success',
          details: {},
          details_hash: 'x',
        })
        .execute(),
    );
    await expect(
      sql`update platform.audit_logs set action = 'tampered' where org_id = ${orgA}`.execute(db),
    ).rejects.toThrow(/append-only/);
  });

  it('resolves a signed-in subject to its member without exposing other data', async () => {
    const found = await memberForSubject(db, `test:Beta-${suffix}`);
    expect(found?.org_id).toBe(orgB);
    expect(await memberForSubject(db, 'test:nobody')).toBeUndefined();
  });
});
