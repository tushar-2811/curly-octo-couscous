import { Writable } from 'node:stream';
import { createDb, createMigrator } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { SESSION_COOKIE, SessionCodec } from './session';

const url = process.env.TEST_DATABASE_URL;

interface Entry {
  id: string;
  action: string;
  actor: { type: string; id: string | null; name: string | null };
  resource: { type: string; id: string | null; name: string | null; kind: string | null };
  outcome: string;
  details: Record<string, unknown>;
}

describe.skipIf(!url)('audit log API', () => {
  const logger = createLogger({
    service: 'web',
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger });
  const run = Date.now().toString(36);
  const domain = `audit-${run}.test`;
  let app: FastifyInstance;
  let admin = '';
  let employeeId = '';

  const cookieFrom = (res: LightMyRequestResponse) =>
    `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
  const call = (cookie: string, method: 'GET' | 'POST', path: string, payload?: object) =>
    app.inject({ method, url: path, headers: { cookie }, ...(payload ? { payload } : {}) });
  const signIn = async (email: string, name: string) =>
    cookieFrom(
      await app.inject({
        method: 'POST',
        url: '/v1/auth/dev-login',
        payload: { email, name },
      }),
    );
  const search = async (qs = '') => {
    const res = await call(admin, 'GET', `/v1/audit${qs}`);
    expect(res.statusCode).toBe(200);
    return res.json() as { entries: Entry[]; next_cursor: string | null };
  };

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
    const created = await call(await signIn(`owner@${domain}`, 'Owner'), 'POST', '/v1/orgs', {
      name: 'Audit Co',
      domain,
    });
    admin = cookieFrom(created);
    const hired = await call(admin, 'POST', '/v1/employees', {
      display_name: 'Nova',
      role_key: 'frontend_engineer',
      email: `nova@${domain}`,
    });
    employeeId = hired.json().employee.id;
    await call(admin, 'POST', '/v1/members', {
      display_name: 'Mia',
      email: `mia@${domain}`,
      title: null,
      role: 'member',
      org_unit_id: null,
      manager_id: null,
    });
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('lists newest first with names, and pages without gaps', async () => {
    const all = await search();
    expect(all.entries.length).toBeGreaterThanOrEqual(5);
    const ids = all.entries.map((e) => e.id);
    expect([...ids].sort().reverse()).toEqual(ids);
    const hired = all.entries.find((e) => e.action === 'member.hired')!;
    expect(hired.actor).toMatchObject({ type: 'member', name: 'Owner' });
    expect(hired.resource).toMatchObject({ type: 'member', name: 'Nova', kind: 'ai' });

    const first = await search('?limit=2');
    expect(first.entries).toHaveLength(2);
    expect(first.next_cursor).toBe(first.entries[1]!.id);
    const second = await search(`?limit=2&cursor=${first.next_cursor}`);
    expect(second.entries.map((e) => e.id)).toEqual(ids.slice(2, 4));
  });

  it('filters by item, category, person and dates', async () => {
    const nova = await search(`?resource=${employeeId}`);
    expect(nova.entries.length).toBeGreaterThan(0);
    expect(nova.entries.every((e) => e.resource.id === employeeId)).toBe(true);
    expect(nova.entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(['member.hired', 'member.company_email_set', 'member.state_changed']),
    );

    const orgs = await search('?category=organization');
    expect(orgs.entries.map((e) => e.action)).toEqual(['organization.created']);

    const today = new Date().toISOString().slice(0, 10);
    expect((await search(`?from=${today}&to=${today}`)).entries.length).toBeGreaterThan(0);
    expect((await search('?from=2001-01-01&to=2001-01-02')).entries).toHaveLength(0);

    const filters = (await call(admin, 'GET', '/v1/audit/filters')).json();
    const owner = filters.actors.find((a: { name: string }) => a.name === 'Owner');
    expect(owner).toBeDefined();
    expect(filters.actions).toContain('member.hired');
    const byOwner = await search(`?actor=${owner.id}`);
    expect(byOwner.entries.every((e) => e.actor.id === owner.id)).toBe(true);
  });

  it('rejects bad filters with field errors', async () => {
    const bad = await call(admin, 'GET', '/v1/audit?from=2026-13-40&outcome=maybe');
    expect(bad.statusCode).toBe(400);
    const paths = bad.json().errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['from', 'outcome']));
    const reversed = await call(admin, 'GET', '/v1/audit?from=2026-11-20&to=2026-11-10');
    expect(reversed.statusCode).toBe(400);
    expect(reversed.json().errors[0].path).toBe('to');
  });

  it('is for admins only', async () => {
    const mia = await signIn(`mia@${domain}`, 'Mia');
    const res = await call(mia, 'GET', '/v1/audit');
    expect(res.statusCode).toBe(403);
    expect((await call(mia, 'GET', '/v1/audit/filters')).statusCode).toBe(403);
  });
});
