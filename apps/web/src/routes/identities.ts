import { createHash, randomBytes } from 'node:crypto';
import { withTenant, type Member, type Tx } from '@aiw/db';
import { deleteSecret, readSecret, storeSecret, type ActorContext } from '@aiw/platform';
import {
  checkLinkedIdentity,
  checkLinkRequester,
  consumeLinkRequest,
  createLinkRequest,
  disconnectIdentity,
  getEmployee,
  IDENTITY_SCOPES,
  IdentityLinkError,
  listIdentities,
  recordLinkFailure,
  saveLinkedIdentity,
  type LinkErrorCode,
  type VerifiedGoogleIdentity,
} from '@aiw/workforce';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember, type AuthDeps } from '../auth';
import { employeeDto, identityDto } from '../dto';
import { AppError } from '../errors';
import { GoogleOAuthError } from '../google-oauth';

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');

const idParam = z.object({ id: z.uuid('Invalid id') });
const identityParams = z.object({ id: z.uuid('Invalid id'), identityId: z.uuid('Invalid id') });
const callbackQuery = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
});

/** Google's own error codes on the redirect, mapped to what we tell the admin. */
function googleRedirectError(error: string): LinkErrorCode {
  if (error === 'access_denied') return 'consent_denied';
  if (error === 'admin_policy_enforced' || error === 'org_internal') return 'admin_blocked';
  return 'google_error';
}

/** Revoke a token at Google after the database change; failure is logged, not fatal. */
export async function revokeQuietly(
  deps: AuthDeps,
  log: FastifyBaseLogger,
  token: string | null,
  context: Record<string, unknown>,
): Promise<void> {
  if (!token) return;
  if (!deps.google) {
    log.warn({ ...context, code: 'google_not_configured' }, 'cannot revoke token at Google');
    return;
  }
  try {
    await deps.google.oauth.revoke(token);
    log.info(context, 'token revoked at Google');
  } catch (err) {
    log.error({ ...context, err }, 'token revocation at Google failed; it expires on its own');
  }
}

/** Tell the onboarding workflow; a Temporal outage is logged and retried from the page. */
async function signalLinked(
  deps: AuthDeps,
  log: FastifyBaseLogger,
  orgId: string,
  memberId: string,
): Promise<boolean> {
  if (!deps.onboarding) return false;
  try {
    await deps.onboarding.identityLinked(orgId, memberId);
    return true;
  } catch (err) {
    log.error(
      { err, employee_id: memberId, code: 'workflow_unavailable' },
      'could not start onboarding workflow; the employee page offers a retry',
    );
    return false;
  }
}

/**
 * Disconnect identities inside `trx`; returns the refresh tokens to revoke after commit.
 * Used by Disconnect (flow D) and by termination.
 */
export async function disconnectIdentities(
  trx: Tx,
  ctx: ActorContext,
  deps: AuthDeps,
  memberId: string,
  reason: 'manual' | 'terminated',
  only?: string,
  actor: Member | null = null,
): Promise<(string | null)[]> {
  const live = (await listIdentities(trx, memberId)).filter(
    (i) => i.connection_status !== 'disconnected' && (!only || i.id === only),
  );
  const tokens: (string | null)[] = [];
  for (const identity of live) {
    const { credentialRef } = await disconnectIdentity(
      trx,
      ctx,
      actor,
      memberId,
      identity.id,
      reason,
    );
    if (!credentialRef) continue;
    tokens.push(deps.google ? await readSecret(trx, deps.google.secrets, credentialRef) : null);
    await deleteSecret(trx, credentialRef);
  }
  return tokens;
}

/** Linking an AI employee's company Google account (Phase 1, slice 5; flows B and D). */
export function registerIdentityRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db } = deps;

  app.post('/v1/employees/:id/identities/link-start', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    if (!deps.google) {
      throw new AppError(
        503,
        'google_not_configured',
        'Google sign-in isn’t set up',
        'Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY to the server settings, then restart it.',
      );
    }
    const { oauth, secrets } = deps.google;
    const scopes = deps.google.scopes ?? IDENTITY_SCOPES;
    const state = random();
    const nonce = random();
    const verifier = random();
    const started = await withTenant(db, ctx.orgId, (trx) =>
      createLinkRequest(trx, ctx, member, id, {
        stateHash: sha256(state),
        nonceHash: sha256(nonce),
        pkceVerifier: secrets.seal(verifier),
        scopes,
      }),
    );
    const authorizationUrl = oauth.authorizationUrl({
      state,
      nonce,
      codeChallenge: sha256(verifier),
      scopes,
      loginHint: started.expectedEmail,
      hostedDomain: started.domain,
    });
    request.log.info(
      { employee_id: id, expected_email: started.expectedEmail },
      'google link started',
    );
    return {
      authorization_url: authorizationUrl,
      expires_at: started.expiresAt.toISOString(),
      requested_scopes: scopes,
    };
  });

  /**
   * Google redirects the browser here (through the dashboard's /api proxy). Every
   * outcome redirects back to the dashboard with a result code; nothing is rendered.
   */
  app.get('/v1/oauth/google/callback', async (request, reply) => {
    const query = callbackQuery.safeParse(request.query);
    const q = query.success ? query.data : {};
    const toList = (code: string) =>
      reply.redirect(`/employees?link_error=${code}&request_id=${request.id}`);

    if (!deps.google) return toList('google_error');
    const google = deps.google;

    let session: Awaited<ReturnType<typeof requireMember>>;
    try {
      session = await requireMember(request, db);
    } catch {
      request.log.warn({ code: 'session_mismatch' }, 'google callback without a valid session');
      return toList('session_mismatch');
    }
    const { member: actor, ctx } = session;
    if (!q.state) return toList('link_expired');

    // 1. The request: single use, unexpired, started by this admin.
    let linkRequest;
    try {
      linkRequest = await withTenant(db, ctx.orgId, (trx) =>
        consumeLinkRequest(trx, sha256(q.state!)),
      );
      checkLinkRequester(linkRequest, actor.id);
    } catch (err) {
      if (!(err instanceof IdentityLinkError)) throw err;
      request.log.warn({ code: err.code }, 'google callback rejected');
      return toList(err.code);
    }
    const memberId = linkRequest.member_id;
    const back = (params: string) =>
      reply.redirect(`/employees/${memberId}?${params}&request_id=${request.id}`);
    const fail = async (code: LinkErrorCode, details: Record<string, unknown> = {}) => {
      request.log.warn({ employee_id: memberId, code, ...details }, 'google link failed');
      await withTenant(db, ctx.orgId, (trx) =>
        recordLinkFailure(trx, ctx, memberId, code, details),
      ).catch((err: unknown) =>
        request.log.error({ err, employee_id: memberId }, 'could not audit link failure'),
      );
      return back(`link_error=${code}`);
    };

    if (q.error) return fail(googleRedirectError(q.error), { google_error: q.error });
    if (!q.code) return fail('google_error', { reason: 'no_code' });

    // 2. Exchange the code (with the PKCE verifier) and verify the ID token.
    let refreshToken: string | null = null;
    let identity: VerifiedGoogleIdentity;
    try {
      const tokens = await google.oauth.exchangeCode(
        q.code,
        google.secrets.open(linkRequest.pkce_verifier),
      );
      refreshToken = tokens.refreshToken;
      const claims = await google.oauth.verifyIdToken(tokens.idToken);
      if (!claims.nonce || sha256(claims.nonce) !== linkRequest.nonce_hash) {
        await revokeQuietly(deps, request.log, refreshToken, { employee_id: memberId });
        return fail('google_error', { reason: 'nonce_mismatch' });
      }
      // Test call as the account: the token really belongs to the same Google user.
      const sub = await google.oauth.userInfoSubject(tokens.accessToken);
      if (sub !== claims.sub) {
        await revokeQuietly(deps, request.log, refreshToken, { employee_id: memberId });
        return fail('google_error', { reason: 'subject_mismatch' });
      }
      identity = {
        sub: claims.sub,
        email: claims.email,
        emailVerified: claims.emailVerified,
        hostedDomain: claims.hostedDomain,
        grantedScopes: tokens.scopes,
      };
    } catch (err) {
      await revokeQuietly(deps, request.log, refreshToken, { employee_id: memberId });
      const reason = err instanceof GoogleOAuthError ? (err.oauthError ?? 'http_error') : 'error';
      request.log.error(
        { err, employee_id: memberId },
        'google token exchange or verification failed',
      );
      return fail(reason === 'invalid_grant' ? 'link_expired' : 'google_error', { reason });
    }

    // 3. Our checks, then store the token and link, all in one transaction.
    let linked;
    try {
      linked = await withTenant(db, ctx.orgId, async (trx) => {
        await checkLinkedIdentity(trx, ctx, linkRequest, identity);
        const ref = refreshToken
          ? await storeSecret(trx, google.secrets, ctx.orgId, 'google_refresh_token', refreshToken)
          : null;
        return saveLinkedIdentity(trx, ctx, linkRequest, identity, ref);
      });
    } catch (err) {
      await revokeQuietly(deps, request.log, refreshToken, { employee_id: memberId });
      if (err instanceof IdentityLinkError) {
        return fail(err.code, {
          signed_in_email: identity.email,
          hosted_domain: identity.hostedDomain,
        });
      }
      throw err;
    }
    request.log.info(
      {
        employee_id: memberId,
        identity_id: linked.id,
        email: linked.email_address,
        has_refresh_token: refreshToken !== null,
      },
      'google account linked',
    );
    await signalLinked(deps, request.log, ctx.orgId, memberId);
    return back('link=connected');
  });

  app.post('/v1/employees/:id/identities/:identityId/disconnect', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id, identityId } = identityParams.parse(request.params);
    const { tokens, row, identities } = await withTenant(db, ctx.orgId, async (trx) => {
      const before = await listIdentities(trx, id);
      if (!before.some((i) => i.id === identityId)) {
        throw new AppError(404, 'not_found', 'Linked account not found');
      }
      const revoked = await disconnectIdentities(trx, ctx, deps, id, 'manual', identityId, member);
      return {
        tokens: revoked,
        row: await getEmployee(trx, id),
        identities: await listIdentities(trx, id),
      };
    });
    for (const token of tokens) {
      await revokeQuietly(deps, request.log, token, { employee_id: id, identity_id: identityId });
    }
    if (deps.onboarding) {
      await deps.onboarding
        .identityDisconnected(id)
        .catch((err: unknown) =>
          request.log.warn({ err, employee_id: id }, 'could not signal onboarding workflow'),
        );
    }
    request.log.info(
      { employee_id: id, identity_id: identityId, state: row.status },
      'google account disconnected',
    );
    return { employee: employeeDto(row), identities: identities.map(identityDto) };
  });

  /** Retry the hand-off to the onboarding workflow (e.g. after a Temporal outage). */
  app.post('/v1/employees/:id/onboarding/continue', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    if (member.person_role !== 'admin') {
      throw new AppError(403, 'forbidden', 'Only organization admins can do this');
    }
    const row = await withTenant(db, ctx.orgId, (trx) => getEmployee(trx, id));
    if (row.status !== 'identity_connected') {
      throw new AppError(
        409,
        'invalid_state',
        'Onboarding has already moved on',
        'Reload the page.',
      );
    }
    if (!(await signalLinked(deps, request.log, ctx.orgId, id))) {
      throw new AppError(
        503,
        'workflow_unavailable',
        'Onboarding can’t continue right now',
        'The background worker is unreachable. Try again in a minute.',
      );
    }
    return { ok: true };
  });
}
