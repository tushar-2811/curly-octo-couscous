import { Writable } from 'node:stream';
import {
  claimMemberForEmail,
  createDb,
  createMigrator,
  memberForSubject,
  withTenant,
  type Member,
} from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { ActorContext } from '@aiw/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrgUnit,
  deleteOrgUnit,
  listOrgUnits,
  MAX_UNIT_DEPTH,
  updateOrgUnit,
} from './org-units';
import { registerOrganization } from './organizations';
import {
  addPerson,
  directReports,
  getMemberRow,
  listMembers,
  setLineManager,
  updateMember,
} from './people';

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe.skipIf(!url)('org structure and people', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  let admin: Member;
  let ctx: ActorContext;
  const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.orgId, fn);

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:struct-${run}`,
      email: `owner@struct-${run}.test`,
      displayName: 'Owner',
      orgName: 'Structure Co',
      domain: `struct-${run}.test`,
      requestId: 'req-setup',
    });
    admin = reg.member;
    ctx = { orgId: reg.organization.id, actorMemberId: admin.id, requestId: 'req-test' };
  });
  afterAll(async () => db.destroy());

  it('builds a department → team tree and refuses loops, duplicates and deep nesting', async () => {
    await inOrg(async (trx) => {
      const eng = await createOrgUnit(trx, ctx, admin, {
        name: 'Engineering',
        kind: 'department',
        parentId: null,
      });
      const fe = await createOrgUnit(trx, ctx, admin, {
        name: 'Frontend',
        kind: 'team',
        parentId: eng.id,
      });
      await expect(
        createOrgUnit(trx, ctx, admin, { name: 'frontend', kind: 'team', parentId: eng.id }),
      ).rejects.toMatchObject({ code: 'name_taken', field: 'name' });
      await expect(
        updateOrgUnit(trx, ctx, admin, eng.id, { parentId: fe.id }),
      ).rejects.toMatchObject({ code: 'cycle' });

      let parent = fe.id;
      for (let depth = 3; depth <= MAX_UNIT_DEPTH; depth++) {
        parent = (
          await createOrgUnit(trx, ctx, admin, {
            name: `Level ${depth}`,
            kind: 'other',
            parentId: parent,
          })
        ).id;
      }
      await expect(
        createOrgUnit(trx, ctx, admin, { name: 'Too deep', kind: 'other', parentId: parent }),
      ).rejects.toMatchObject({ code: 'too_deep' });

      const moved = await updateOrgUnit(trx, ctx, admin, fe.id, { parentId: null, name: 'Web' });
      expect(moved).toMatchObject({ parent_id: null, name: 'Web' });
    });
  });

  it('adds people, assigns units and managers, and refuses reporting loops', async () => {
    await inOrg(async (trx) => {
      const [eng] = (await listOrgUnits(trx)).filter((u) => u.name === 'Engineering');
      const lead = await addPerson(trx, ctx, admin, {
        displayName: 'Lin Lead',
        email: `lin@struct-${run}.test`,
        title: 'Engineering lead',
        role: 'manager',
        orgUnitId: eng!.id,
        managerId: admin.id,
      });
      const dev = await addPerson(trx, ctx, admin, {
        displayName: 'Dev One',
        email: `DEV@struct-${run}.test`,
        title: null,
        role: 'member',
        orgUnitId: eng!.id,
        managerId: lead.id,
      });

      await expect(
        addPerson(trx, ctx, admin, {
          displayName: 'Dup',
          email: `dev@struct-${run}.test`,
          title: null,
          role: 'member',
          orgUnitId: null,
          managerId: null,
        }),
      ).rejects.toMatchObject({ code: 'email_taken', field: 'email' });
      await expect(setLineManager(trx, ctx, admin, admin.id, dev.id)).rejects.toMatchObject({
        code: 'cycle',
      });
      await expect(setLineManager(trx, ctx, admin, dev.id, dev.id)).rejects.toMatchObject({
        code: 'invalid_manager',
      });

      expect(await getMemberRow(trx, dev.id)).toMatchObject({
        manager_name: 'Lin Lead',
        org_unit_name: 'Engineering',
        email: `dev@struct-${run}.test`,
      });
      expect((await directReports(trx, lead.id)).map((r) => r.display_name)).toEqual(['Dev One']);
      expect((await listMembers(trx, { q: 'engineering' })).map((m) => m.display_name)).toEqual([
        'Lin Lead',
      ]);
      expect((await listOrgUnits(trx)).find((u) => u.name === 'Engineering')?.member_count).toBe(2);

      await expect(deleteOrgUnit(trx, ctx, admin, eng!.id)).rejects.toMatchObject({
        code: 'unit_not_empty',
      });
    });
  });

  it('protects the last admin and forbids non-admins', async () => {
    await inOrg(async (trx) => {
      await expect(
        updateMember(trx, ctx, admin, admin.id, { role: 'member' }),
      ).rejects.toMatchObject({ code: 'last_admin' });
      await expect(
        updateMember(trx, ctx, admin, admin.id, { status: 'deactivated' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      const [lin] = await listMembers(trx, { q: 'Lin Lead' });
      await expect(
        createOrgUnit(trx, ctx, lin!, { name: 'Sneaky', kind: 'team', parentId: null }),
      ).rejects.toMatchObject({ code: 'forbidden' });

      await updateMember(trx, ctx, admin, lin!.id, { role: 'admin' });
      const demoted = await updateMember(trx, ctx, admin, admin.id, { role: 'member' });
      expect(demoted.person_role).toBe('member');

      const actions = await trx
        .selectFrom('platform.audit_logs')
        .select('action')
        .where('resource_id', '=', admin.id)
        .execute();
      expect(actions.map((a) => a.action)).toContain('member.updated');
    });
  });

  it('lets a person added by email claim their membership on first sign-in', async () => {
    const email = `newbie@struct-${run}.test`;
    await inOrg(async (trx) => {
      // The original owner was demoted above; Lin is now the admin.
      const [lin] = await listMembers(trx, { q: 'Lin Lead' });
      await addPerson(trx, ctx, lin!, {
        displayName: 'Newbie',
        email,
        title: null,
        role: 'member',
        orgUnitId: null,
        managerId: null,
      });
    });
    expect(await memberForSubject(db, `test:newbie-${run}`)).toBeUndefined();
    const claimed = await claimMemberForEmail(db, `test:newbie-${run}`, email.toUpperCase());
    expect(claimed?.org_id).toBe(ctx.orgId);
    expect((await memberForSubject(db, `test:newbie-${run}`))?.member_id).toBe(claimed?.member_id);
    // Once claimed, nobody else can claim the same membership.
    expect(await claimMemberForEmail(db, `test:imposter-${run}`, email)).toBeUndefined();
  });
});
