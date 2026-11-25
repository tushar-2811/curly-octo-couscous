import { Writable } from 'node:stream';
import { createDb, createMigrator } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { SESSION_COOKIE, SessionCodec } from './session';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('access API', () => {
  const logger = createLogger({
    service: 'web',
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger });
  const run = Date.now().toString(36);
  const domain = `accapi-${run}.test`;
  let app: FastifyInstance;
  let admin = '';

  const cookieFrom = (res: LightMyRequestResponse) =>
    `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;

  async function signIn(email: string, name: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { email, name },
    });
    expect(res.statusCode).toBe(200);
    return cookieFrom(res);
  }
  const call = (
    cookie: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    payload?: object,
  ) => app.inject({ method, url: path, headers: { cookie }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    app = await buildApp({
      logger,
      meta: { service: 'web', version: 't', env: 'test' },
      readinessChecks: {},
      auth: {
        db,
        codec: new SessionCodec('s'.repeat(32), 1),
        secureCookies: false,
        devLogin: true,
      },
    });
    const first = await signIn(`owner@${domain}`, 'Owner');
    const created = await call(first, 'POST', '/v1/orgs', { name: 'Access API Co', domain });
    expect(created.statusCode).toBe(201);
    admin = cookieFrom(created);
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('registers resources, grants access and checks it', async () => {
    const catalog = (await call(admin, 'GET', '/v1/access/catalog')).json();
    expect(catalog.resource_types.map((t: { key: string }) => t.key)).toEqual([
      'repo',
      'jira_project',
      'chat_space',
      'figma_file',
    ]);

    const badId = await call(admin, 'POST', '/v1/resources', { type: 'repo', external_id: 'nope' });
    expect(badId.statusCode).toBe(422);
    expect(badId.json().errors[0].path).toBe('external_id');

    const created = await call(admin, 'POST', '/v1/resources', {
      type: 'repo',
      external_id: 'acme/web-app',
      name: 'Web app',
      tags: ['frontend'],
    });
    expect(created.statusCode).toBe(201);
    const repo = created.json().resource;
    const dup = await call(admin, 'POST', '/v1/resources', {
      type: 'repo',
      external_id: 'Acme/Web-App',
    });
    expect(dup.statusCode).toBe(409);

    const nova = (
      await call(admin, 'POST', '/v1/employees', {
        display_name: 'Nova',
        role_key: 'frontend_engineer',
      })
    ).json().employee;

    const before = (await call(admin, 'GET', `/v1/employees/${nova.id}`)).json();
    const grantsCheck = (d: { onboarding: { checks: { key: string }[] } }) =>
      d.onboarding.checks.find((c) => c.key === 'grants');
    expect(grantsCheck(before)).toMatchObject({ status: 'pending' });

    const wrongLevel = await call(admin, 'POST', `/v1/employees/${nova.id}/grants`, {
      resource_type: 'repo',
      resource_id: repo.id,
      level: 'admin',
    });
    expect(wrongLevel.statusCode).toBe(400);

    const granted = await call(admin, 'POST', `/v1/employees/${nova.id}/grants`, {
      resource_type: 'repo',
      resource_id: repo.id,
      level: 'write',
      branches: ['ai/*'],
    });
    expect(granted.statusCode).toBe(201);
    expect(granted.json().grant).toMatchObject({
      effect: 'allow',
      level: 'write',
      branches: ['ai/*'],
      resource: { external_id: 'acme/web-app' },
      granted_by: { name: 'Owner' },
    });

    const access = (await call(admin, 'GET', `/v1/employees/${nova.id}/access`)).json();
    expect(access.can_manage).toBe(true);
    expect(access.effective).toEqual([
      expect.objectContaining({ level: 'write', branches: ['ai/*'] }),
    ]);

    const check = (q: string) =>
      call(admin, 'GET', `/v1/employees/${nova.id}/authorize?resource_id=${repo.id}&${q}`);
    expect((await check('action=repo.push_branch&branch=ai/x')).json().decision.allowed).toBe(true);
    expect((await check('action=repo.push_branch&branch=main')).json().decision.reason).toBe(
      'branch_not_allowed',
    );
    expect((await check('action=jira.comment')).json().decision.allowed).toBe(false);
    expect((await check('action=nonsense')).statusCode).toBe(400);

    // Members can see access but not change it.
    await call(admin, 'POST', '/v1/members', { display_name: 'Viewer', email: `viewer@${domain}` });
    const viewer = await signIn(`viewer@${domain}`, 'Viewer');
    const seen = (await call(viewer, 'GET', `/v1/employees/${nova.id}/access`)).json();
    expect(seen).toMatchObject({ can_manage: false, can_revoke: false });
    const grantId = seen.grants[0].id;
    expect(
      (await call(viewer, 'DELETE', `/v1/employees/${nova.id}/grants/${grantId}`)).statusCode,
    ).toBe(403);
    expect(
      (await call(viewer, 'POST', '/v1/resources', { type: 'jira_project', external_id: 'PF' }))
        .statusCode,
    ).toBe(403);

    // Termination revokes everything in the same transaction.
    await call(admin, 'POST', `/v1/employees/${nova.id}/terminate`, {});
    const after = (
      await call(admin, 'GET', `/v1/employees/${nova.id}/access?include_revoked=true`)
    ).json();
    expect(after.effective).toEqual([]);
    expect(after.grants[0]).toMatchObject({ revoke_reason: 'terminated' });
    expect(
      (
        await call(admin, 'POST', `/v1/employees/${nova.id}/grants`, {
          resource_type: 'repo',
          resource_id: repo.id,
          level: 'read',
        })
      ).statusCode,
    ).toBe(409);

    const removed = await call(admin, 'DELETE', `/v1/resources/${repo.id}`);
    expect(removed.statusCode).toBe(200);
    const list = (await call(admin, 'GET', '/v1/resources')).json().resources;
    expect(list.map((r: { id: string }) => r.id)).not.toContain(repo.id);
  });
});
