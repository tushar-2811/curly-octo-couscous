import { Writable } from 'node:stream';
import { createDb, createMigrator } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { SESSION_COOKIE, SessionCodec } from './session';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('AI employees API', () => {
  const logger = createLogger({
    service: 'web',
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger });
  const run = Date.now().toString(36);
  const domain = `empapi-${run}.test`;
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
    const created = await call(first, 'POST', '/v1/orgs', { name: 'Emp API Co', domain });
    expect(created.statusCode).toBe(201);
    admin = cookieFrom(created);
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('hires from a template and walks the lifecycle', async () => {
    const templates = (await call(admin, 'GET', '/v1/role-templates')).json().templates;
    expect(templates.map((t: { key: string }) => t.key)).toContain('frontend_engineer');

    const bad = await call(admin, 'POST', '/v1/employees', { display_name: '', role_key: '' });
    expect(bad.statusCode).toBe(400);
    const paths = bad.json().errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['display_name', 'role_key']));

    const wrongDomain = await call(admin, 'POST', '/v1/employees', {
      display_name: 'Nova',
      role_key: 'frontend_engineer',
      email: 'nova@gmail.com',
    });
    expect(wrongDomain.statusCode).toBe(422);
    expect(wrongDomain.json().errors[0].path).toBe('email');

    const hired = await call(admin, 'POST', '/v1/employees', {
      display_name: 'Nova',
      role_key: 'frontend_engineer',
      instructions: 'Use Tailwind',
    });
    expect(hired.statusCode).toBe(201);
    const nova = hired.json().employee;
    expect(nova).toMatchObject({
      type: 'ai',
      status: 'draft',
      role_key: 'frontend_engineer',
      title: 'Frontend Software Engineer',
    });

    const detail = (await call(admin, 'GET', `/v1/employees/${nova.id}`)).json();
    expect(detail.template.name).toBe('Frontend engineer');
    expect(detail.onboarding).toMatchObject({ state: 'draft', onboarding: true });
    expect(detail.onboarding.checks.find((c: { key: string }) => c.key === 'identity').status).toBe(
      'pending',
    );

    const withEmail = await call(admin, 'PUT', `/v1/employees/${nova.id}/company-email`, {
      email: `nova@${domain}`,
    });
    expect(withEmail.json().employee).toMatchObject({
      status: 'external_identity_pending',
      email: `nova@${domain}`,
    });

    const patched = await call(admin, 'PATCH', `/v1/employees/${nova.id}`, { max_concurrency: 11 });
    expect(patched.statusCode).toBe(400);
    expect(
      (await call(admin, 'PATCH', `/v1/employees/${nova.id}`, { max_concurrency: 3 })).json()
        .employee.max_concurrency,
    ).toBe(3);

    // Not active yet, so it can't be suspended; it can be terminated.
    expect((await call(admin, 'POST', `/v1/employees/${nova.id}/suspend`, {})).statusCode).toBe(
      409,
    );
    const ended = await call(admin, 'POST', `/v1/employees/${nova.id}/terminate`, {});
    expect(ended.json().employee.status).toBe('terminated');
    expect(
      (await call(admin, 'PATCH', `/v1/employees/${nova.id}`, { title: 'x' })).statusCode,
    ).toBe(409);

    const list = (await call(admin, 'GET', '/v1/employees?status=terminated')).json().employees;
    expect(list.map((e: { id: string }) => e.id)).toContain(nova.id);
    expect((await call(admin, 'GET', `/v1/employees/${crypto.randomUUID()}`)).statusCode).toBe(404);

    // AI employees can't be "deactivated" through the people API.
    const viaPeople = await call(admin, 'PATCH', `/v1/members/${nova.id}`, {
      status: 'deactivated',
    });
    expect(viaPeople.statusCode).toBe(409);
  });

  it('lets members view but not hire', async () => {
    await call(admin, 'POST', '/v1/members', { display_name: 'Viewer', email: `viewer@${domain}` });
    const viewer = await signIn(`viewer@${domain}`, 'Viewer');
    expect((await call(viewer, 'GET', '/v1/employees')).statusCode).toBe(200);
    const denied = await call(viewer, 'POST', '/v1/employees', {
      display_name: 'X',
      role_key: 'qa_engineer',
    });
    expect(denied.statusCode).toBe(403);
  });
});
