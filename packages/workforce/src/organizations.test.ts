import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkforceError } from './errors';
import {
  getOrganization,
  normalizeDomain,
  registerOrganization,
  slugify,
  updateOrganization,
  validateOrgDomain,
} from './organizations';

describe('domain rules', () => {
  it('normalizes pasted URLs', () => {
    expect(normalizeDomain(' https://www.Acme.io/about ')).toBe('acme.io');
  });

  it('rejects invalid and personal domains', () => {
    expect(() => validateOrgDomain('not a domain')).toThrow(WorkforceError);
    expect(() => validateOrgDomain('gmail.com')).toThrow(/personal email/);
    expect(() => validateOrgDomain('acme.io')).not.toThrow();
  });

  it('builds URL-safe slugs', () => {
    expect(slugify('ABC Technologies, Inc.')).toBe('abc-technologies-inc');
  });
});

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe.skipIf(!url)('registerOrganization', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
  });
  afterAll(async () => db.destroy());

  const input = (n: string) => ({
    subject: `test:${n}-${run}`,
    email: `Founder@${n}-${run}.test`,
    displayName: 'Founder',
    orgName: `Org ${n}`,
    domain: `${n}-${run}.test`,
    requestId: `req-${n}`,
  });

  it('creates the org and admin, with audit records and events in the same transaction', async () => {
    const { organization, member } = await registerOrganization(db, input('one'));
    expect(member).toMatchObject({
      person_role: 'admin',
      type: 'human',
      email: `founder@one-${run}.test`,
    });
    const { audits, events } = await withTenant(db, organization.id, async (trx) => ({
      audits: await trx
        .selectFrom('platform.audit_logs')
        .select(['action', 'request_id', 'actor_member_id'])
        .execute(),
      events: await trx.selectFrom('platform.outbox_events').select('type').execute(),
    }));
    expect(audits.map((a) => a.action).sort()).toEqual(['member.added', 'organization.created']);
    expect(audits.every((a) => a.request_id === 'req-one' && a.actor_member_id === member.id)).toBe(
      true,
    );
    expect(events.map((e) => e.type).sort()).toEqual(['MemberAdded', 'OrganizationCreated']);
  });

  it('refuses a second organization for the same person, and a taken domain', async () => {
    await registerOrganization(db, input('two'));
    await expect(registerOrganization(db, input('two'))).rejects.toMatchObject({
      code: 'already_member',
    });
    await expect(
      registerOrganization(db, { ...input('three'), domain: `two-${run}.test` }),
    ).rejects.toMatchObject({ code: 'domain_taken', field: 'domain' });
  });

  it('lets only admins rename the org, and audits before and after', async () => {
    const { organization, member } = await registerOrganization(db, input('four'));
    const ctx = { orgId: organization.id, actorMemberId: member.id, requestId: 'req-rename' };
    await withTenant(db, organization.id, async (trx) => {
      await updateOrganization(trx, ctx, member, { name: 'Renamed Co' });
      expect((await getOrganization(trx, organization.id)).name).toBe('Renamed Co');
      const audit = await trx
        .selectFrom('platform.audit_logs')
        .select('details')
        .where('action', '=', 'organization.updated')
        .executeTakeFirstOrThrow();
      expect(audit.details).toEqual({
        before: { name: 'Org four' },
        after: { name: 'Renamed Co' },
      });
      await expect(
        updateOrganization(trx, ctx, { ...member, person_role: 'member' }, { name: 'Nope' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });
});
