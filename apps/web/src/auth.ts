import type { Embedder, JiraReader, StructuredLlm } from '@aiw/engine';
import type { MessageDispatcher } from './messages';
import { withTenant, type Database, type Kysely, type Member } from '@aiw/db';
import { addLogContext } from '@aiw/logger';
import type { ActorContext, SecretBox } from '@aiw/platform';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors';
import type { GoogleOAuth } from './google-oauth';
import type { OnboardingSignals } from './onboarding';
import { SESSION_COOKIE, type SessionClaims, type SessionCodec } from './session';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionClaims | null;
  }
}

export interface AuthDeps {
  db: Kysely<Database>;
  codec: SessionCodec;
  secureCookies: boolean;
  /** Linking AI employees' Google accounts. Absent until GOOGLE_CLIENT_ID is set. */
  google?: {
    oauth: GoogleOAuth;
    secrets: SecretBox;
    /** Asked for at sign-in. Default: identity only. With Chat set up, Chat access too. */
    scopes?: readonly string[];
  };
  onboarding?: OnboardingSignals;
  /** Message handling (Phase 2). `llm` is null until OPENAI_API_KEY is set. */
  engine?: {
    llm: StructuredLlm | null;
    embedder?: Embedder | null;
    jira?: JiraReader | null;
    /** Processing in the worker. Absent in tests: messages are processed in the request. */
    dispatcher?: MessageDispatcher;
    allowTestMessages: boolean;
  };
}

/**
 * Read and verify the session cookie on every request. A bad or expired cookie is
 * cleared and logged; the request continues as signed out.
 */
export function registerSession(app: FastifyInstance, deps: AuthDeps): void {
  app.decorateRequest('session', null);
  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const claims = await deps.codec.verify(token);
    if (!claims) {
      request.log.warn({ code: 'invalid_session' }, 'invalid or expired session cookie; cleared');
      clearSessionCookie(reply, deps.secureCookies);
      return;
    }
    request.session = claims;
    addLogContext({ org_id: claims.oid, member_id: claims.mid });
  });
}

export async function setSessionCookie(
  reply: FastifyReply,
  deps: AuthDeps,
  claims: SessionClaims,
): Promise<void> {
  reply.setCookie(SESSION_COOKIE, await deps.codec.sign(claims), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.secureCookies,
    maxAge: deps.codec.maxAgeSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure });
}

export function requireSession(request: FastifyRequest): SessionClaims {
  if (!request.session) {
    throw new AppError(
      401,
      'unauthenticated',
      'Sign in required',
      'Your session has ended. Sign in again.',
    );
  }
  return request.session;
}

export interface MemberContext {
  member: Member;
  ctx: ActorContext;
}

/**
 * The signed-in person must be an active member of an active organization. Checked
 * against the database on every call, not just the cookie.
 */
export async function requireMember(
  request: FastifyRequest,
  db: Kysely<Database>,
): Promise<MemberContext> {
  const session = requireSession(request);
  if (!session.mid || !session.oid) {
    throw new AppError(
      403,
      'no_organization',
      'No organization yet',
      'Register your organization first.',
    );
  }
  const { mid, oid } = session;
  const found = await withTenant(db, oid, async (trx) => {
    const member = await trx
      .selectFrom('workforce.members')
      .selectAll()
      .where('id', '=', mid)
      .executeTakeFirst();
    const org = await trx
      .selectFrom('workforce.organizations')
      .select('status')
      .where('id', '=', oid)
      .executeTakeFirst();
    return { member, org };
  });
  if (
    !found.member ||
    found.member.auth_subject !== session.sub ||
    found.member.status !== 'active'
  ) {
    request.log.warn({ code: 'member_inactive' }, 'session refers to a missing or inactive member');
    throw new AppError(
      401,
      'unauthenticated',
      'Sign in required',
      'Your access has changed. Sign in again.',
    );
  }
  if (found.org?.status !== 'active') {
    throw new AppError(
      403,
      'organization_suspended',
      'Organization suspended',
      'Contact your administrator.',
    );
  }
  return { member: found.member, ctx: { orgId: oid, actorMemberId: mid, requestId: request.id } };
}
