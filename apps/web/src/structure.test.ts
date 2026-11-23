import { Writable } from 'node:stream';
import { createDb, createMigrator } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { SESSION_COOKIE, SessionCodec } from './session';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('org structure API', () => {
  const logger = createLogger({
    service: 'web',
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger });
  const run = Date.now().toString(36);
  const domain = `structapi-${run}.test`;
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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
    const created = await call(first, 'POST', '/v1/orgs', { name: 'Struct API Co', domain });
    expect(created.statusCode).toBe(201);
    admin = cookieFrom(created);
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('manages units and people end to end, including first sign-in of an added person', async () => {
    const eng = (
      await call(admin, 'POST', '/v1/org-units', { name: 'Engineering', kind: 'department' })
    ).json().unit;
    const fe = await call(admin, 'POST', '/v1/org-units', {
      name: 'Frontend',
      kind: 'team',
      parent_id: eng.id,
    });
    expect(fe.statusCode).toBe(201);
    const dup = await call(admin, 'POST', '/v1/org-units', {
      name: 'frontend',
      kind: 'team',
      parent_id: eng.id,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'name_taken', errors: [{ path: 'name' }] });

    const me = (await call(admin, 'GET', '/v1/me')).json().member;
    const added = await call(admin, 'POST', '/v1/members', {
      display_name: 'Priya Patel',
      email: `Priya@${domain}`,
      title: 'Frontend engineer',
      role: 'member',
      org_unit_id: fe.json().unit.id,
      manager_id: me.id,
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().member).toMatchObject({
      email: `priya@${domain}`,
      org_unit: { name: 'Frontend' },
      manager: { name: 'Owner' },
      signed_in: false,
    });
    const priyaId = added.json().member.id as string;

    // Priya signs in for the first time and lands in the organization.
    const priya = await signIn(`priya@${domain}`, 'Priya');
    const priyaMe = await call(priya, 'GET', '/v1/me');
    expect(priyaMe.json().organization.name).toBe('Struct API Co');
    expect((await call(admin, 'GET', `/v1/members/${priyaId}`)).json().member.signed_in).toBe(true);

    // A member (not admin) can read the org but not change it.
    expect((await call(priya, 'GET', '/v1/org-units')).statusCode).toBe(200);
    const forbidden = await call(priya, 'POST', '/v1/org-units', { name: 'Shadow', kind: 'team' });
    expect(forbidden.statusCode).toBe(403);

    // Reporting loops are refused with a field error.
    const loop = await call(admin, 'PATCH', `/v1/members/${me.id}`, { manager_id: priyaId });
    expect(loop.statusCode).toBe(422);
    expect(loop.json()).toMatchObject({ code: 'cycle', errors: [{ path: 'manager_id' }] });

    // Non-empty units can't be deleted; the manager shows the report.
    expect((await call(admin, 'DELETE', `/v1/org-units/${eng.id}`)).statusCode).toBe(409);
    const detail = (await call(admin, 'GET', `/v1/members/${me.id}`)).json();
    expect(detail.reports.map((r: { display_name: string }) => r.display_name)).toEqual([
      'Priya Patel',
    ]);

    // Filters and search.
    const search = (await call(admin, 'GET', '/v1/members?q=frontend')).json().members;
    expect(search.map((m: { display_name: string }) => m.display_name)).toEqual(['Priya Patel']);

    // Deactivating Priya cuts her access on the next request.
    expect(
      (await call(admin, 'PATCH', `/v1/members/${priyaId}`, { status: 'deactivated' })).statusCode,
    ).toBe(200);
    expect((await call(priya, 'GET', '/v1/org-units')).statusCode).toBe(401);
  });

  it('protects the last admin and validates ids', async () => {
    const me = (await call(admin, 'GET', '/v1/me')).json().member;
    const res = await call(admin, 'PATCH', `/v1/members/${me.id}`, { role: 'member' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'last_admin', errors: [{ path: 'role' }] });
    expect((await call(admin, 'GET', '/v1/members/not-a-uuid')).statusCode).toBe(400);
    expect(
      (await call(admin, 'GET', '/v1/members/00000000-0000-7000-8000-000000000000')).statusCode,
    ).toBe(404);
  });
});
