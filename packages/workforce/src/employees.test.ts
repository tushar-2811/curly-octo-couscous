import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant, type Member } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { ActorContext } from '@aiw/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getEmployee,
  hireEmployee,
  listEmployees,
  onboardingChecklist,
  resumeEmployee,
  setCompanyEmail,
  suspendEmployee,
  terminateEmployee,
  updateEmployee,
} from './employees';
import { AI_TRANSITIONS, canTransition, transition } from './lifecycle';
import { createOrgUnit } from './org-units';
import { registerOrganization } from './organizations';
import { addPerson, updateMember } from './people';
import { findRoleTemplate, ROLE_TEMPLATES } from './role-templates';

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe('state machine', () => {
  it('matches the Identity linking §2 diagram', () => {
    expect(canTransition('draft', 'external_identity_pending')).toBe(true);
    expect(canTransition('draft', 'active')).toBe(false);
    expect(canTransition('active', 'suspended')).toBe(true);
    expect(canTransition('onboarding_failed', 'integrations_pending')).toBe(true);
    expect(AI_TRANSITIONS.terminated).toEqual([]);
    for (const targets of Object.values(AI_TRANSITIONS)) {
      for (const t of targets) expect(Object.keys(AI_TRANSITIONS)).toContain(t);
    }
  });

  it('has unique role template keys', () => {
    const keys = ROLE_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe.skipIf(!url)('hiring AI employees', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  const domain = `hire-${run}.test`;
  let admin: Member;
  let ctx: ActorContext;
  const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.orgId, fn);

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:hire-${run}`,
      email: `owner@${domain}`,
      displayName: 'Owner',
      orgName: 'Hire Co',
      domain,
      requestId: 'req-setup',
    });
    admin = reg.member;
    ctx = { orgId: reg.organization.id, actorMemberId: admin.id, requestId: 'req-test' };
  });
  afterAll(async () => db.destroy());

  it('hires from a template into draft, then moves to identity pending on email', async () => {
    await inOrg(async (trx) => {
      const team = await createOrgUnit(trx, ctx, admin, {
        name: 'Web',
        kind: 'team',
        parentId: null,
      });
      const hired = await hireEmployee(trx, ctx, admin, {
        displayName: 'Nova',
        roleKey: 'frontend_engineer',
        title: null,
        orgUnitId: team.id,
        managerId: admin.id,
        instructions: '  Use Tailwind.  ',
      });
      expect(hired.status).toBe('draft');
      const row = await getEmployee(trx, hired.id);
      expect(row).toMatchObject({
        type: 'ai',
        title: 'Frontend Software Engineer',
        role_key: 'frontend_engineer',
        instructions: 'Use Tailwind.',
        max_concurrency: 2,
        manager_id: admin.id,
        org_unit_name: 'Web',
      });

      const checklist = onboardingChecklist(row, findRoleTemplate(row.role_key));
      const byKey = Object.fromEntries(checklist.checks.map((c) => [c.key, c.status]));
      expect(byKey).toMatchObject({
        profile: 'passed',
        identity: 'pending',
        team: 'passed',
        manager: 'passed',
        grants: 'pending',
        figma: 'pending',
      });
      expect(checklist.onboarding).toBe(true);

      await expect(
        setCompanyEmail(trx, ctx, admin, hired.id, 'nova@gmail.com'),
      ).rejects.toMatchObject({
        code: 'email_domain',
        field: 'email',
      });
      const pending = await setCompanyEmail(trx, ctx, admin, hired.id, `Nova.AI@${domain}`);
      expect(pending).toMatchObject({
        status: 'external_identity_pending',
        email: `nova.ai@${domain}`,
      });

      const audit = await trx
        .selectFrom('platform.audit_logs')
        .select(['action', 'details'])
        .where('resource_id', '=', hired.id)
        .orderBy('id') // uuidv7: creation order, even within one transaction
        .execute();
      expect(audit.map((a) => a.action)).toEqual([
        'member.hired',
        'member.manager_changed',
        'member.company_email_set',
        'member.state_changed',
      ]);
      const events = await trx
        .selectFrom('platform.outbox_events')
        .select(['type', 'data'])
        .where('aggregate_id', '=', hired.id)
        .execute();
      expect(events.map((e) => e.type)).toContain('MemberHired');
      expect(events.find((e) => e.type === 'MemberStateChanged')?.data).toMatchObject({
        from: 'draft',
        to: 'external_identity_pending',
      });
    });
  });

  it('refuses unknown templates, taken emails, non-admins and AI status edits', async () => {
    await inOrg(async (trx) => {
      await expect(
        hireEmployee(trx, ctx, admin, {
          displayName: 'X',
          roleKey: 'astronaut',
          title: null,
          orgUnitId: null,
          managerId: null,
          instructions: '',
        }),
      ).rejects.toMatchObject({ code: 'unknown_template' });
      await expect(
        hireEmployee(trx, ctx, admin, {
          displayName: 'Copy',
          roleKey: 'qa_engineer',
          title: null,
          orgUnitId: null,
          managerId: null,
          instructions: '',
          email: `owner@${domain}`,
        }),
      ).rejects.toMatchObject({ code: 'email_taken' });

      const person = await addPerson(trx, ctx, admin, {
        displayName: 'Member',
        email: `member@${domain}`,
        title: null,
        role: 'member',
        orgUnitId: null,
        managerId: null,
      });
      await expect(
        hireEmployee(trx, ctx, person, {
          displayName: 'Nope',
          roleKey: 'qa_engineer',
          title: null,
          orgUnitId: null,
          managerId: null,
          instructions: '',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });

      const qa = await hireEmployee(trx, ctx, admin, {
        displayName: 'Quinn',
        roleKey: 'qa_engineer',
        title: 'Test lead',
        orgUnitId: null,
        managerId: null,
        instructions: '',
      });
      await expect(
        updateMember(trx, ctx, admin, qa.id, { status: 'deactivated' }),
      ).rejects.toMatchObject({
        code: 'invalid_state',
      });
      await updateEmployee(trx, ctx, admin, qa.id, {
        maxConcurrency: 4,
        instructions: 'Be thorough',
      });
      expect(await getEmployee(trx, qa.id)).toMatchObject({
        max_concurrency: 4,
        instructions: 'Be thorough',
        title: 'Test lead',
      });
    });
  });

  it('suspends, resumes and terminates only from allowed states', async () => {
    await inOrg(async (trx) => {
      const be = await hireEmployee(trx, ctx, admin, {
        displayName: 'Bea',
        roleKey: 'backend_engineer',
        title: null,
        orgUnitId: null,
        managerId: null,
        instructions: '',
      });
      await expect(suspendEmployee(trx, ctx, admin, be.id)).rejects.toMatchObject({
        code: 'invalid_state',
      });
      await expect(transition(trx, ctx, be, 'active', { reason: 'skip' })).rejects.toMatchObject({
        code: 'invalid_state',
      });

      // Onboarding completes in later slices; put the employee in active directly.
      await trx
        .updateTable('workforce.members')
        .set({ status: 'active' })
        .where('id', '=', be.id)
        .execute();
      const suspended = await suspendEmployee(trx, ctx, admin, be.id);
      expect(suspended).toMatchObject({ status: 'suspended', suspension_reason: 'manual' });
      expect(await resumeEmployee(trx, ctx, admin, be.id)).toMatchObject({
        status: 'active',
        suspension_reason: null,
      });

      const done = await terminateEmployee(trx, ctx, admin, be.id);
      expect(done.status).toBe('terminated');
      await expect(
        updateEmployee(trx, ctx, admin, be.id, { displayName: 'Again' }),
      ).rejects.toMatchObject({
        code: 'invalid_state',
      });
      expect((await listEmployees(trx, { status: 'terminated' })).map((e) => e.id)).toContain(
        be.id,
      );
    });
  });
});
