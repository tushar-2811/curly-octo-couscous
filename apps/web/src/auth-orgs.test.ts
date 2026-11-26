import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadWebConfig } from './config';
import { SESSION_COOKIE, SessionCodec } from './session';

describe('config', () => {
  const base = { DATABASE_URL: 'postgres://x@localhost/db', SESSION_SECRET: 'x'.repeat(32) };

  it('refuses development sign-in outside local', () => {
    expect(() => loadWebConfig({ ...base, APP_ENV: 'staging', AUTH_DEV_LOGIN: 'true' })).toThrow(
      /AUTH_DEV_LOGIN/,
    );
    expect(
      loadWebConfig({ ...base, APP_ENV: 'local', AUTH_DEV_LOGIN: 'true' }).AUTH_DEV_LOGIN,
    ).toBe(true);
  });

  it('requires a long session secret', () => {
    expect(() => loadWebConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('sign-in and organizations API', () => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'web',
    level: 'debug',
    destination: new Writable({
      write(chunk: Buffer, _e, cb) {
        for (const l of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l));
        cb();
      },
    }),
  });
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger });
  const run = Date.now().toString(36);
  let app: FastifyInstance;

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
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  async function signIn(email: string, name = 'Ada') {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { email, name },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    return `${SESSION_COOKIE}=${cookie?.value}`;
  }

  it('rejects unauthenticated requests with a problem response', async () => {
    const res = await app.inject({ url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('signs in, registers an org, and becomes its admin', async () => {
    let cookie = await signIn(`ada@${run}.test`);
    const me1 = await app.inject({ url: '/v1/me', headers: { cookie } });
    expect(me1.json()).toMatchObject({ user: { email: `ada@${run}.test` }, organization: null });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { cookie, 'x-request-id': `req-create-${run}` },
      payload: { name: 'Acme Robotics', domain: `https://www.acme-${run}.test/` },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().organization).toMatchObject({
      name: 'Acme Robotics',
      domain: `acme-${run}.test`,
    });
    expect(created.json().member).toMatchObject({ role: 'admin' });
    cookie = `${SESSION_COOKIE}=${created.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;

    const me2 = await app.inject({ url: '/v1/me', headers: { cookie } });
    expect(me2.json().organization.name).toBe('Acme Robotics');

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/v1/orgs/current',
      headers: { cookie },
      payload: { name: 'Acme Robotics Ltd' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().organization.name).toBe('Acme Robotics Ltd');

    // The audit trail carries the API request id, so logs and audit records line up.
    const orgId = me2.json().organization.id as string;
    const audits = await withTenant(db, orgId, (trx) =>
      trx.selectFrom('platform.audit_logs').select(['action', 'request_id']).execute(),
    );
    expect(audits).toContainEqual({
      action: 'organization.created',
      request_id: `req-create-${run}`,
    });
    expect(audits.map((a) => a.action)).toContain('organization.updated');
    expect(lines.some((l) => l.msg === 'organization registered' && l.org_id === orgId)).toBe(true);
  });

  it('returns field-level errors the form can show', async () => {
    const cookie = await signIn(`bob@${run}.test`, 'Bob');
    const personal = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { cookie },
      payload: { name: 'Bob Co', domain: 'gmail.com' },
    });
    expect(personal.statusCode).toBe(422);
    expect(personal.json()).toMatchObject({
      code: 'domain_not_allowed',
      errors: [{ path: 'domain' }],
    });

    const taken = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { cookie },
      payload: { name: 'Bob Co', domain: `acme-${run}.test` },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'domain_taken', errors: [{ path: 'domain' }] });

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { cookie },
      payload: { name: 'B' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      invalid
        .json()
        .errors.map((e: { path: string }) => e.path)
        .sort(),
    ).toEqual(['domain', 'name']);
  });

  it('rejects non-JSON state changes (CSRF guard) and forged cookies', async () => {
    const form = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=x&domain=y.test',
    });
    expect(form.statusCode).toBe(415);

    const forged = await new SessionCodec('f'.repeat(32), 1).sign({
      sub: 'dev:evil@x.test',
      email: 'evil@x.test',
      name: 'Evil',
    });
    const res = await app.inject({
      url: '/v1/me',
      headers: { cookie: `${SESSION_COOKIE}=${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
