import { claimMemberForEmail, memberForSubject, withTenant } from '@aiw/db';
import { recordAudit } from '@aiw/platform';
import { getMember, getOrganization } from '@aiw/workforce';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clearSessionCookie, requireSession, setSessionCookie, type AuthDeps } from '../auth';
import { memberDto, organizationDto } from '../dto';
import { AppError } from '../errors';
import type { SessionClaims } from '../session';

const devLoginBody = z.object({
  email: z.email('Enter a valid email address').max(254),
  name: z.string().trim().min(1, 'Enter your name').max(120),
});

/**
 * Add org membership to the claims if the person has one. On first sign-in of someone an
 * admin added by email, attach this identity to that member (audited as member.joined).
 */
async function withMembership(
  deps: AuthDeps,
  claims: SessionClaims,
  requestId: string,
): Promise<SessionClaims> {
  let found = await memberForSubject(deps.db, claims.sub);
  if (!found) {
    const claimed = await claimMemberForEmail(deps.db, claims.sub, claims.email);
    if (claimed) {
      await withTenant(deps.db, claimed.org_id, (trx) =>
        recordAudit(
          trx,
          { orgId: claimed.org_id, actorMemberId: claimed.member_id, requestId },
          {
            action: 'member.joined',
            resourceType: 'member',
            resourceId: claimed.member_id,
            details: { email: claims.email },
          },
        ),
      );
      found = { ...claimed, status: 'active' };
    }
  }
  if (!found || found.status !== 'active') {
    const { mid: _m, oid: _o, ...rest } = claims;
    return rest;
  }
  return { ...claims, mid: found.member_id, oid: found.org_id };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthDeps,
  options: { devLogin: boolean },
): void {
  app.get('/v1/auth/methods', () => ({ dev_login: options.devLogin, google: false }));

  if (options.devLogin) {
    app.post(
      '/v1/auth/dev-login',
      { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = devLoginBody.parse(request.body);
        const email = body.email.toLowerCase();
        const claims = await withMembership(
          deps,
          { sub: `dev:${email}`, email, name: body.name },
          request.id,
        );
        await setSessionCookie(reply, deps, claims);
        if (claims.oid && claims.mid) {
          const { oid, mid } = claims;
          await withTenant(deps.db, oid, (trx) =>
            recordAudit(
              trx,
              { orgId: oid, actorMemberId: mid, requestId: request.id },
              {
                action: 'auth.signed_in',
                resourceType: 'member',
                resourceId: mid,
                details: { method: 'dev' },
              },
            ),
          );
        }
        request.log.info({ method: 'dev', org_id: claims.oid, member_id: claims.mid }, 'signed in');
        return { signed_in: true, has_organization: Boolean(claims.oid) };
      },
    );
  }

  app.post('/v1/auth/logout', async (request, reply) => {
    if (request.session) request.log.info({ member_id: request.session.mid }, 'signed out');
    clearSessionCookie(reply, deps.secureCookies);
    return reply.status(204).send();
  });

  /** Who am I? Also upgrades the cookie if the person has joined an org since sign-in. */
  app.get('/v1/me', async (request, reply) => {
    const session = requireSession(request);
    const claims = await withMembership(deps, session, request.id);
    if (claims.oid !== session.oid || claims.mid !== session.mid) {
      await setSessionCookie(reply, deps, claims);
    }
    const user = { email: claims.email, name: claims.name };
    if (!claims.oid || !claims.mid) return { user, member: null, organization: null };
    const { oid, mid } = claims;
    const { member, organization } = await withTenant(deps.db, oid, async (trx) => {
      const m = await getMember(trx, mid);
      return { member: m, organization: await getOrganization(trx, oid) };
    });
    if (member.status !== 'active') {
      throw new AppError(401, 'unauthenticated', 'Sign in required', 'Your access has changed.');
    }
    return { user, member: memberDto(member), organization: organizationDto(organization, member) };
  });
}
