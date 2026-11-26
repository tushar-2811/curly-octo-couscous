import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import { SecretBox } from '@aiw/platform';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import type { GoogleIdClaims, GoogleOAuth } from './google-oauth';
import type { OnboardingSignals } from './onboarding';
import { redactUrl } from './request-context';
import { SESSION_COOKIE, SessionCodec } from './session';

const url = process.env.TEST_DATABASE_URL;

describe('redactUrl', () => {
  it('hides OAuth codes and state', () => {
    expect(redactUrl('/v1/oauth/google/callback?state=abc&code=4/xyz&scope=openid')).toBe(
      '/v1/oauth/google/callback?state=[redacted]&code=[redacted]&scope=openid',
    );
  });
});

/** A fake Google: the "code" names which account signs in. */
class FakeGoogle implements GoogleOAuth {
  accounts = new Map<string, Omit<GoogleIdClaims, 'nonce'>>();
  lastNonce = '';
  revoked: string[] = [];

  authorizationUrl(p: Parameters<GoogleOAuth['authorizationUrl']>[0]): string {
    this.lastNonce = p.nonce;
    const u = new URL('https://accounts.google.test/auth');
    u.searchParams.set('state', p.state);
    u.searchParams.set('login_hint', p.loginHint);
    u.searchParams.set('scope', p.scopes.join(' '));
    return u.toString();
  }
  async exchangeCode(code: string) {
    const account = this.accounts.get(code);
    if (!account) throw new Error('unknown code');
    return {
      idToken: JSON.stringify({ ...account, nonce: this.lastNonce }),
      accessToken: `access-${code}`,
      refreshToken: `refresh-${code}`,
      scopes: [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
    };
  }
  async verifyIdToken(idToken: string): Promise<GoogleIdClaims> {
    return JSON.parse(idToken) as GoogleIdClaims;
  }
  async userInfoSubject(accessToken: string) {
    return this.accounts.get(accessToken.replace('access-', ''))!.sub;
  }
  async revoke(token: string) {
    this.revoked.push(token);
  }
}

class FakeOnboarding implements OnboardingSignals {
  linked: string[] = [];
  disconnected: string[] = [];
  async identityLinked(_orgId: string, memberId: string) {
    this.linked.push(memberId);
  }
  async identityDisconnected(memberId: string) {
    this.disconnected.push(memberId);
  }
}

describe.skipIf(!url)('Google account linking API', () => {
  const logger = createLogger({
    service: 'web',
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger });
  const run = Date.now().toString(36);
  const domain = `glink-${run}.test`;
  const google = new FakeGoogle();
  const onboarding = new FakeOnboarding();
  let app: FastifyInstance;
  let admin = '';
  let orgId = '';

  const cookieFrom = (res: LightMyRequestResponse) =>
    `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
  const call = (cookie: string, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    app.inject({ method, url: path, headers: { cookie }, ...(payload ? { payload } : {}) });

  async function hire(email: string) {
    const res = await call(admin, 'POST', '/v1/employees', {
      display_name: email.split('@')[0],
      role_key: 'frontend_engineer',
      email,
    });
    expect(res.statusCode).toBe(201);
    return res.json().employee.id as string;
  }

  async function startLink(id: string) {
    const res = await call(admin, 'POST', `/v1/employees/${id}/identities/link-start`);
    expect(res.statusCode).toBe(200);
    return new URL(res.json().authorization_url).searchParams.get('state')!;
  }

  const callback = (cookie: string, query: string) =>
    call(cookie, 'GET', `/v1/oauth/google/callback?${query}`);

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
        google: { oauth: google, secrets: new SecretBox(randomBytes(32).toString('base64')) },
        onboarding,
      },
    });
    const signIn = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { email: `owner@${domain}`, name: 'Owner' },
    });
    const created = await call(cookieFrom(signIn), 'POST', '/v1/orgs', {
      name: 'Link API Co',
      domain,
    });
    expect(created.statusCode).toBe(201);
    admin = cookieFrom(created);
    orgId = created.json().organization.id;
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('links the employee’s account and hands off to onboarding', async () => {
    const id = await hire(`nova@${domain}`);
    google.accounts.set('nova', {
      sub: `g-${run}-nova`,
      email: `nova@${domain}`,
      emailVerified: true,
      hostedDomain: domain,
    });
    const state = await startLink(id);

    const res = await callback(admin, `state=${state}&code=nova`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(new RegExp(`^/employees/${id}\\?link=connected`));
    expect(onboarding.linked).toContain(id);

    const detail = await call(admin, 'GET', `/v1/employees/${id}`);
    const body = detail.json();
    expect(body.employee.status).toBe('identity_connected');
    expect(body.google_configured).toBe(true);
    expect(body.identities).toHaveLength(1);
    expect(body.identities[0]).toMatchObject({
      email: `nova@${domain}`,
      connection_status: 'connected',
    });
    // Tokens never leave the server, and are encrypted at rest.
    expect(detail.body).not.toContain('refresh-nova');
    expect(detail.body).not.toContain('credential');
    const secrets = await withTenant(db, orgId, (trx) =>
      trx.selectFrom('platform.secrets').select('ciphertext').execute(),
    );
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.ciphertext).not.toContain('refresh-nova');

    // The same state can't be used twice.
    const replay = await callback(admin, `state=${state}&code=nova`);
    expect(replay.headers.location).toMatch(/^\/employees\?link_error=link_expired/);

    // Disconnect: token revoked at Google, secret deleted, back to waiting.
    const identityId = body.identities[0].id;
    const off = await call(
      admin,
      'POST',
      `/v1/employees/${id}/identities/${identityId}/disconnect`,
    );
    expect(off.statusCode).toBe(200);
    expect(off.json().employee.status).toBe('external_identity_pending');
    expect(google.revoked).toContain('refresh-nova');
    expect(onboarding.disconnected).toContain(id);
    const left = await withTenant(db, orgId, (trx) =>
      trx.selectFrom('platform.secrets').select('id').execute(),
    );
    expect(left).toHaveLength(0);
  });

  it('refuses the wrong account and revokes its token', async () => {
    const id = await hire(`echo@${domain}`);
    google.accounts.set('owner', {
      sub: `g-${run}-owner`,
      email: `owner@${domain}`,
      emailVerified: true,
      hostedDomain: domain,
    });
    const state = await startLink(id);
    const res = await callback(admin, `state=${state}&code=owner`);
    expect(res.headers.location).toMatch(
      new RegExp(`^/employees/${id}\\?link_error=wrong_account`),
    );
    expect(google.revoked).toContain('refresh-owner');
    const detail = (await call(admin, 'GET', `/v1/employees/${id}`)).json();
    expect(detail.employee.status).toBe('external_identity_pending');
    expect(detail.identities).toHaveLength(0);
  });

  it('reports cancelled consent and a missing session', async () => {
    const id = await hire(`kilo@${domain}`);
    const state = await startLink(id);
    const denied = await callback(admin, `state=${state}&error=access_denied`);
    expect(denied.headers.location).toMatch(
      new RegExp(`^/employees/${id}\\?link_error=consent_denied`),
    );
    const signedOut = await callback('', `state=${await startLink(id)}&code=x`);
    expect(signedOut.headers.location).toMatch(/^\/employees\?link_error=session_mismatch/);
  });

  it('needs an email first, and Google to be configured', async () => {
    const draft = await call(admin, 'POST', '/v1/employees', {
      display_name: 'Draft',
      role_key: 'frontend_engineer',
    });
    const id = draft.json().employee.id;
    const res = await call(admin, 'POST', `/v1/employees/${id}/identities/link-start`);
    expect(res.statusCode).toBe(409);
    expect(res.json().title).toBe('Enter the company Google account first');

    const bare = await buildApp({
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
    const off = await bare.inject({
      method: 'POST',
      url: `/v1/employees/${id}/identities/link-start`,
      headers: { cookie: admin },
    });
    expect(off.statusCode).toBe(503);
    expect(off.json().code).toBe('google_not_configured');
    await bare.close();
  });
});
