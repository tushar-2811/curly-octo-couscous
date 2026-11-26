import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant, type Member } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { ActorContext } from '@aiw/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getEmployee, hireEmployee } from './employees';
import {
  checkLinkedIdentity,
  checkLinkRequester,
  consumeLinkRequest,
  continueOnboarding,
  createLinkRequest,
  disconnectIdentity,
  IDENTITY_SCOPES,
  listIdentities,
  missingScopes,
  saveLinkedIdentity,
  type VerifiedGoogleIdentity,
} from './identities';
import { registerOrganization } from './organizations';

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe('missingScopes', () => {
  it('accepts Google’s long names for email and profile', () => {
    expect(
      missingScopes(IDENTITY_SCOPES, [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ]),
    ).toEqual([]);
    expect(missingScopes(IDENTITY_SCOPES, ['openid'])).toEqual(['email', 'profile']);
  });
});

describe.skipIf(!url)('linking Google accounts', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  const domain = `link-${run}.test`;
  let admin: Member;
  let ctx: ActorContext;
  let n = 0;
  const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.orgId, fn);

  const google = (over: Partial<VerifiedGoogleIdentity> = {}): VerifiedGoogleIdentity => ({
    sub: `sub-${run}-1`,
    email: `nova@${domain}`,
    emailVerified: true,
    hostedDomain: domain,
    grantedScopes: ['openid', 'email', 'profile'],
    ...over,
  });

  async function hire(email: string) {
    return inOrg((trx) =>
      hireEmployee(trx, ctx, admin, {
        displayName: `Bot ${++n}`,
        roleKey: 'frontend_engineer',
        title: null,
        orgUnitId: null,
        managerId: null,
        instructions: '',
        email,
      }),
    );
  }

  async function request(memberId: string, now = new Date()) {
    const stateHash = `state-${run}-${++n}`;
    await inOrg((trx) =>
      createLinkRequest(trx, ctx, admin, memberId, {
        stateHash,
        nonceHash: 'nonce',
        pkceVerifier: 'sealed',
        scopes: IDENTITY_SCOPES,
        now,
      }),
    );
    return stateHash;
  }

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:link-${run}`,
      email: `owner@${domain}`,
      displayName: 'Owner',
      orgName: 'Link Co',
      domain,
      requestId: 'req-setup',
    });
    admin = reg.member;
    ctx = { orgId: reg.organization.id, actorMemberId: admin.id, requestId: 'req-test' };
  });
  afterAll(async () => db.destroy());

  it('links the right account, then continues onboarding', async () => {
    const nova = await hire(`nova@${domain}`);
    const state = await request(nova.id);
    const req = await inOrg((trx) => consumeLinkRequest(trx, state));
    expect(() => checkLinkRequester(req, admin.id)).not.toThrow();
    expect(() => checkLinkRequester(req, nova.id)).toThrow(
      expect.objectContaining({ code: 'session_mismatch' }),
    );

    // Single use.
    await expect(inOrg((trx) => consumeLinkRequest(trx, state))).rejects.toMatchObject({
      code: 'link_expired',
    });

    await inOrg(async (trx) => {
      await checkLinkedIdentity(trx, ctx, req, google());
      await saveLinkedIdentity(trx, ctx, req, google(), null);
    });
    const [row, identities] = await inOrg((trx) =>
      Promise.all([getEmployee(trx, nova.id), listIdentities(trx, nova.id)]),
    );
    expect(row.status).toBe('identity_connected');
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      provider_user_id: `sub-${run}-1`,
      email_address: `nova@${domain}`,
      connection_status: 'connected',
    });

    const ctxSystem = { orgId: ctx.orgId, actorMemberId: null, requestId: null };
    expect(await inOrg((trx) => continueOnboarding(trx, ctxSystem, nova.id))).toBe(
      'integrations_pending',
    );
    // Idempotent.
    expect(await inOrg((trx) => continueOnboarding(trx, ctxSystem, nova.id))).toBe(
      'integrations_pending',
    );

    // Disconnect: back to waiting for an account; the identity is kept as history.
    const { credentialRef } = await inOrg((trx) =>
      disconnectIdentity(trx, ctx, admin, nova.id, identities[0]!.id, 'manual'),
    );
    expect(credentialRef).toBeNull();
    const after = await inOrg((trx) => getEmployee(trx, nova.id));
    expect(after.status).toBe('external_identity_pending');
    const kept = await inOrg((trx) => listIdentities(trx, nova.id));
    expect(kept[0]?.connection_status).toBe('disconnected');
  });

  it('rejects the wrong account with the reason', async () => {
    const bot = await hire(`checks@${domain}`);
    const state = await request(bot.id);
    const req = await inOrg((trx) => consumeLinkRequest(trx, state));
    const reject = (identity: VerifiedGoogleIdentity) =>
      inOrg((trx) => checkLinkedIdentity(trx, ctx, req, identity));
    const ok = google({ email: `checks@${domain}`, sub: `sub-${run}-checks` });

    await expect(reject({ ...ok, emailVerified: false })).rejects.toMatchObject({
      code: 'email_unverified',
    });
    await expect(reject({ ...ok, hostedDomain: null })).rejects.toMatchObject({
      code: 'not_workspace',
    });
    await expect(reject({ ...ok, hostedDomain: 'other.test' })).rejects.toMatchObject({
      code: 'wrong_domain',
    });
    await expect(reject({ ...ok, email: `owner@${domain}` })).rejects.toMatchObject({
      code: 'wrong_account',
      message: expect.stringContaining(`checks@${domain}`),
    });
    await expect(reject({ ...ok, grantedScopes: ['openid'] })).rejects.toMatchObject({
      code: 'scopes_missing',
    });
    await expect(reject(ok)).resolves.toBeUndefined();
  });

  it('links one Google account to one employee only', async () => {
    const a = await hire(`a@${domain}`);
    const b = await hire(`b@${domain}`);
    const shared = { sub: `sub-${run}-shared` };
    const reqA = await inOrg(async (trx) => consumeLinkRequest(trx, await request(a.id)));
    await inOrg((trx) =>
      saveLinkedIdentity(trx, ctx, reqA, google({ ...shared, email: `a@${domain}` }), null),
    );
    const reqB = await inOrg(async (trx) => consumeLinkRequest(trx, await request(b.id)));
    await expect(
      inOrg((trx) =>
        checkLinkedIdentity(trx, ctx, reqB, google({ ...shared, email: `b@${domain}` })),
      ),
    ).rejects.toMatchObject({ code: 'already_linked' });
    // Even if the check is skipped, the database refuses.
    await expect(
      inOrg((trx) =>
        saveLinkedIdentity(trx, ctx, reqB, google({ ...shared, email: `b@${domain}` }), null),
      ),
    ).rejects.toMatchObject({ code: 'already_linked' });
  });

  it('expires requests after 10 minutes and needs an email first', async () => {
    const late = await hire(`late@${domain}`);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    const state = await request(late.id, old);
    await expect(inOrg((trx) => consumeLinkRequest(trx, state))).rejects.toMatchObject({
      code: 'link_expired',
    });

    const draft = await inOrg((trx) =>
      hireEmployee(trx, ctx, admin, {
        displayName: 'No email',
        roleKey: 'frontend_engineer',
        title: null,
        orgUnitId: null,
        managerId: null,
        instructions: '',
      }),
    );
    await expect(request(draft.id)).rejects.toMatchObject({ code: 'invalid_state' });
  });
});
