import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant, type Member } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { ActorContext } from '@aiw/platform';
import { addPerson, hireEmployee, registerOrganization, setLineManager } from '@aiw/workforce';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branchMatches } from './catalog';
import { effectiveAccess, evaluate, type GrantLike, type ResourceLike } from './evaluate';
import {
  authorize,
  createGrant,
  effectivePermissions,
  grantsCheck,
  listGrants,
  revokeAllGrants,
  revokeGrant,
  updateGrant,
} from './grants';
import { archiveResource, listResources, registerResource, updateResource } from './resources';

const repo = (id: string, tags: string[] = []): ResourceLike => ({
  id,
  type: 'repo',
  tags,
  archived_at: null,
});
const grant = (g: Partial<GrantLike> & Pick<GrantLike, 'id'>): GrantLike => ({
  resource_type: 'repo',
  resource_id: null,
  effect: 'allow',
  level: 'read',
  conditions: {},
  ...g,
});

describe('evaluate', () => {
  it('needs an explicit grant (least privilege)', () => {
    const d = evaluate({
      memberStatus: 'active',
      grants: [],
      resource: repo('r1'),
      action: 'repo.read',
    });
    expect(d).toMatchObject({ allowed: false, reason: 'no_grant' });
  });

  it('write includes read; read does not include write', () => {
    const write = [grant({ id: 'g', resource_id: 'r1', level: 'write' })];
    const read = [grant({ id: 'g', resource_id: 'r1', level: 'read' })];
    const r = repo('r1');
    expect(
      evaluate({ memberStatus: 'active', grants: write, resource: r, action: 'repo.read' }).allowed,
    ).toBe(true);
    expect(
      evaluate({ memberStatus: 'active', grants: read, resource: r, action: 'repo.comment' })
        .allowed,
    ).toBe(false);
  });

  it('lets a deny rule win over any allow', () => {
    const grants = [
      grant({ id: 'all', level: 'write' }),
      grant({ id: 'block', resource_id: 'r2', effect: 'deny', level: 'write' }),
    ];
    expect(
      evaluate({ memberStatus: 'active', grants, resource: repo('r1'), action: 'repo.comment' })
        .allowed,
    ).toBe(true);
    const blocked = evaluate({
      memberStatus: 'active',
      grants,
      resource: repo('r2'),
      action: 'repo.comment',
    });
    expect(blocked).toMatchObject({ allowed: false, reason: 'denied_by_grant', grant_id: 'block' });
    // Denying write still leaves read.
    expect(
      evaluate({ memberStatus: 'active', grants, resource: repo('r2'), action: 'repo.read' })
        .allowed,
    ).toBe(true);
  });

  it('narrows type-wide grants by tag', () => {
    const grants = [grant({ id: 'fe', conditions: { tags: ['frontend'] } })];
    expect(
      evaluate({
        memberStatus: 'active',
        grants,
        resource: repo('a', ['frontend']),
        action: 'repo.read',
      }).allowed,
    ).toBe(true);
    expect(
      evaluate({
        memberStatus: 'active',
        grants,
        resource: repo('b', ['backend']),
        action: 'repo.read',
      }).allowed,
    ).toBe(false);
  });

  it('limits pushes to allowed branches', () => {
    const grants = [
      grant({ id: 'w', resource_id: 'r1', level: 'write', conditions: { branches: ['ai/*'] } }),
    ];
    const base = {
      memberStatus: 'active',
      grants,
      resource: repo('r1'),
      action: 'repo.push_branch',
    } as const;
    expect(evaluate({ ...base, branch: 'ai/PF-1-card' }).allowed).toBe(true);
    expect(evaluate({ ...base, branch: 'main' })).toMatchObject({ reason: 'branch_not_allowed' });
    expect(evaluate({ ...base })).toMatchObject({ reason: 'branch_required' });
    expect(branchMatches('release-*.x', 'release-1.x')).toBe(true);
    expect(branchMatches('a.b', 'axb')).toBe(false);
  });

  it('turns everything off while suspended or terminated', () => {
    const grants = [grant({ id: 'g', level: 'write' })];
    for (const memberStatus of ['suspended', 'terminated']) {
      expect(
        evaluate({ memberStatus, grants, resource: repo('r'), action: 'repo.read' }),
      ).toMatchObject({ reason: 'employee_not_working' });
      expect(effectiveAccess(memberStatus, grants, [repo('r')])).toEqual([]);
    }
  });

  it('reports effective levels after deny rules', () => {
    const grants = [
      grant({ id: 'w', level: 'write', conditions: { branches: ['ai/*'] } }),
      grant({ id: 'd', resource_id: 'r2', effect: 'deny', level: 'write' }),
      grant({ id: 'x', resource_id: 'r3', effect: 'deny', level: 'read' }),
    ];
    const eff = effectiveAccess('active', grants, [repo('r1'), repo('r2'), repo('r3')]);
    expect(eff.map((e) => [e.resource_id, e.level, e.limited_by_deny])).toEqual([
      ['r1', 'write', false],
      ['r2', 'read', true],
      ['r3', null, true],
    ]);
    expect(eff[0]?.branches).toEqual(['ai/*']);
  });
});

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe.skipIf(!url)('grants', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  const domain = `access-${run}.test`;
  let admin: Member;
  let ctx: ActorContext;
  const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.orgId, fn);

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:access-${run}`,
      email: `owner@${domain}`,
      displayName: 'Owner',
      orgName: 'Access Co',
      domain,
      requestId: 'req-setup',
    });
    admin = reg.member;
    ctx = { orgId: reg.organization.id, actorMemberId: admin.id, requestId: 'req-test' };
  });
  afterAll(async () => db.destroy());

  it('registers resources, grants, checks and revokes, with an audit trail', async () => {
    await inOrg(async (trx) => {
      const web = await registerResource(trx, ctx, admin, {
        type: 'repo',
        externalId: 'acme/web-app',
        name: 'Web app',
        tags: ['Frontend'],
      });
      expect(web.tags).toEqual(['frontend']);
      await expect(
        registerResource(trx, ctx, admin, { type: 'repo', externalId: 'ACME/web-app', name: '' }),
      ).rejects.toMatchObject({ code: 'resource_exists', field: 'external_id' });
      await expect(
        registerResource(trx, ctx, admin, {
          type: 'jira_project',
          externalId: 'not a key',
          name: '',
        }),
      ).rejects.toMatchObject({ code: 'invalid_resource', field: 'external_id' });
      const api = await registerResource(trx, ctx, admin, {
        type: 'repo',
        externalId: 'acme/api',
        name: 'API',
        tags: ['backend'],
      });
      const pf = await registerResource(trx, ctx, admin, {
        type: 'jira_project',
        externalId: 'pf',
        name: 'Profile',
      });
      expect(pf.external_id).toBe('PF');

      const nova = await hireEmployee(trx, ctx, admin, {
        displayName: 'Nova',
        roleKey: 'frontend_engineer',
        title: null,
        orgUnitId: null,
        managerId: null,
        instructions: '',
      });
      expect((await grantsCheck(trx, nova.id, ['jira', 'git_host'])).passed).toBe(false);

      // Every frontend-tagged repo, write limited to ai/* branches.
      const repos = await createGrant(trx, ctx, admin, nova.id, {
        resourceType: 'repo',
        resourceId: null,
        effect: 'allow',
        level: 'write',
        tags: ['frontend'],
        branches: ['ai/*'],
      });
      await expect(
        createGrant(trx, ctx, admin, nova.id, {
          resourceType: 'repo',
          resourceId: null,
          effect: 'allow',
          level: 'read',
        }),
      ).rejects.toMatchObject({ code: 'grant_exists' });
      await expect(
        createGrant(trx, ctx, admin, nova.id, {
          resourceType: 'figma_file',
          resourceId: null,
          effect: 'allow',
          level: 'write',
        }),
      ).rejects.toMatchObject({ code: 'invalid_grant', field: 'level' });
      await expect(
        createGrant(trx, ctx, admin, nova.id, {
          resourceType: 'jira_project',
          resourceId: pf.id,
          effect: 'allow',
          level: 'read',
          branches: ['main'],
        }),
      ).rejects.toMatchObject({ code: 'invalid_grant', field: 'branches' });
      await createGrant(trx, ctx, admin, nova.id, {
        resourceType: 'jira_project',
        resourceId: pf.id,
        effect: 'allow',
        level: 'write',
      });

      expect(await authorize(trx, nova.id, 'repo.read', web.id)).toMatchObject({ allowed: true });
      expect(await authorize(trx, nova.id, 'repo.read', api.id)).toMatchObject({
        reason: 'no_grant',
      });
      expect(
        await authorize(trx, nova.id, 'repo.push_branch', web.id, { branch: 'main' }),
      ).toMatchObject({ reason: 'branch_not_allowed' });
      expect(await grantsCheck(trx, nova.id, ['jira', 'git_host'])).toEqual({
        passed: true,
        detail: '1 Jira project, 1 repository',
      });

      // Tagging the API repo frontend brings it under the type-wide grant.
      await updateResource(trx, ctx, admin, api.id, { tags: ['backend', 'frontend'] });
      expect((await effectivePermissions(trx, nova.id)).map((e) => e.resource.external_id)).toEqual(
        ['PF', 'acme/api', 'acme/web-app'],
      );

      await updateGrant(trx, ctx, admin, nova.id, repos.id, { level: 'read' });
      const updated = (await listGrants(trx, nova.id)).find((g) => g.id === repos.id);
      expect(updated).toMatchObject({ level: 'read', conditions: { tags: ['frontend'] } });
      expect(updated?.conditions.branches).toBeUndefined();

      // Removing a resource revokes grants that name it.
      const removed = await archiveResource(trx, ctx, admin, pf.id);
      expect(removed.revoked).toBe(1);
      expect((await listResources(trx)).map((r) => r.external_id)).not.toContain('PF');

      await revokeGrant(trx, ctx, admin, nova.id, repos.id);
      expect(await listGrants(trx, nova.id)).toEqual([]);
      expect((await listGrants(trx, nova.id, { includeRevoked: true })).length).toBe(2);

      const audit = await trx
        .selectFrom('platform.audit_logs')
        .select('action')
        .where('resource_type', 'in', ['grant', 'resource'])
        .orderBy('id')
        .execute();
      expect(audit.map((a) => a.action)).toEqual([
        'resource.registered',
        'resource.registered',
        'resource.registered',
        'grant.created',
        'grant.created',
        'resource.updated',
        'grant.updated',
        'grant.revoked',
        'resource.archived',
        'grant.revoked',
      ]);
      const events = await trx
        .selectFrom('platform.outbox_events')
        .select('type')
        .where('type', 'in', ['GrantChanged', 'GrantRevoked'])
        .execute();
      expect(events.length).toBe(5);
    });
  });

  it('lets a line manager grant, but not other people', async () => {
    await inOrg(async (trx) => {
      const lead = await addPerson(trx, ctx, admin, {
        email: `lead@${domain}`,
        displayName: 'Lead',
        title: null,
        role: 'manager',
        orgUnitId: null,
        managerId: null,
      });
      const other = await addPerson(trx, ctx, admin, {
        email: `other@${domain}`,
        displayName: 'Other',
        title: null,
        role: 'member',
        orgUnitId: null,
        managerId: null,
      });
      const ivy = await hireEmployee(trx, ctx, admin, {
        displayName: 'Ivy',
        roleKey: 'qa_engineer',
        title: null,
        orgUnitId: null,
        managerId: null,
        instructions: '',
      });
      await setLineManager(trx, ctx, admin, ivy.id, lead.id);
      const input = {
        resourceType: 'chat_space' as const,
        resourceId: null,
        effect: 'allow' as const,
        level: 'read' as const,
      };
      await expect(createGrant(trx, ctx, other, ivy.id, input)).rejects.toMatchObject({
        code: 'forbidden',
      });
      const g = await createGrant(trx, ctx, lead, ivy.id, input);
      expect(g.granted_by).toBe(lead.id);

      expect(await revokeAllGrants(trx, ctx, ivy.id, 'terminated')).toBe(1);
      expect(await listGrants(trx, ivy.id)).toEqual([]);
    });
  });
});
