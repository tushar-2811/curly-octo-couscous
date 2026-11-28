import type { AiState, ExternalIdentity, Member, OauthLinkRequest, Tx } from '@aiw/db';
import { recordChange, type ActorContext } from '@aiw/platform';
import { WorkforceError } from './errors';
import { isUniqueViolation, requireAdmin } from './guards';
import { transition } from './lifecycle';
import { getOrganization } from './organizations';

/**
 * Linking an AI employee's company Google account (Identity linking §4, flow B and D).
 * This module holds the rules; the web process talks to Google and passes in what it
 * verified. A typed email is only an expectation: only a verified ID token links.
 */

export const GOOGLE_PROVIDER = 'google_workspace' as const;

/** Identity only for now; Chat and directory scopes are added by incremental consent. */
export const IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

/**
 * Asked for as well when Google Chat is set up (Phase 2): read and post Chat messages, see
 * space names, look up people in the company directory, and read the Chat event queue.
 */
export const CHAT_SCOPES = [
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.messages.create',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/pubsub',
] as const;

/** Requested with Chat: read the employee's inbox and send email as it. */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

export const LINK_REQUEST_TTL_MS = 10 * 60 * 1000;

export type LinkErrorCode =
  | 'link_expired'
  | 'session_mismatch'
  | 'consent_denied'
  | 'admin_blocked'
  | 'email_unverified'
  | 'not_workspace'
  | 'wrong_domain'
  | 'wrong_account'
  | 'already_linked'
  | 'scopes_missing'
  | 'invalid_state'
  | 'google_error';

/** A failed link. The message is shown to the admin and says how to fix it. */
export class IdentityLinkError extends Error {
  constructor(
    public readonly code: LinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityLinkError';
  }
}

export const LINK_ERROR_MESSAGES: Record<LinkErrorCode, string> = {
  link_expired: 'The sign-in link expired or was already used. Start again.',
  session_mismatch:
    'This sign-in was started by someone else or in another browser. Start again from this page.',
  consent_denied: 'Google sign-in was cancelled, so nothing was linked. Start again when ready.',
  admin_blocked:
    'Your Google Workspace admin must allow this app first (Admin console → Security → API controls).',
  email_unverified: 'Google says this account’s email address is not verified.',
  not_workspace:
    'This is a personal Google account. Sign in with the company Google Workspace account.',
  wrong_domain: 'This account is not in your company’s Google Workspace.',
  wrong_account: 'You signed in as another account.',
  already_linked: 'This Google account is already linked to another AI employee.',
  scopes_missing:
    'Some permissions were not granted. Start again and allow all listed permissions.',
  invalid_state: 'This employee is no longer waiting for a Google account.',
  google_error: 'Google did not complete the sign-in. Start again in a minute.',
};

function linkError(code: LinkErrorCode, extra?: string): IdentityLinkError {
  return new IdentityLinkError(
    code,
    extra ? `${LINK_ERROR_MESSAGES[code]} ${extra}` : LINK_ERROR_MESSAGES[code],
  );
}

async function loadAi(trx: Tx, id: string): Promise<Member> {
  const member = await trx
    .selectFrom('workforce.members')
    .selectAll()
    .where('id', '=', id)
    .where('type', '=', 'ai')
    .executeTakeFirst();
  if (!member) throw new WorkforceError('not_found', 'AI employee not found');
  return member;
}

export async function listIdentities(trx: Tx, memberId: string): Promise<ExternalIdentity[]> {
  return trx
    .selectFrom('workforce.external_identities')
    .selectAll()
    .where('member_id', '=', memberId)
    .orderBy('id', 'desc')
    .execute();
}

export interface LinkRequestInput {
  stateHash: string;
  nonceHash: string;
  /** Encrypted by the caller. */
  pkceVerifier: string;
  scopes: readonly string[];
  now?: Date;
}

/**
 * Start linking (flow B, steps 1–2). Admins only, while the employee waits for its
 * Google account. Returns what the authorization URL needs.
 */
export async function createLinkRequest(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  memberId: string,
  input: LinkRequestInput,
): Promise<{ expectedEmail: string; domain: string; expiresAt: Date }> {
  requireAdmin(actor);
  const member = await loadAi(trx, memberId);
  if (member.status !== 'external_identity_pending') {
    throw new WorkforceError(
      'invalid_state',
      member.status === 'draft'
        ? 'Enter the company Google account first'
        : 'This employee is not waiting for a Google account',
    );
  }
  if (!member.email) {
    throw new WorkforceError('invalid_state', 'Enter the company Google account first');
  }
  const org = await getOrganization(trx, ctx.orgId);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + LINK_REQUEST_TTL_MS);
  await trx
    .insertInto('workforce.oauth_link_requests')
    .values({
      state_hash: input.stateHash,
      org_id: ctx.orgId,
      member_id: memberId,
      provider: GOOGLE_PROVIDER,
      expected_email: member.email,
      nonce_hash: input.nonceHash,
      pkce_verifier: input.pkceVerifier,
      requested_scopes: [...input.scopes],
      created_by: actor.id,
      created_at: now,
      expires_at: expiresAt,
    })
    .execute();
  await recordChange(trx, ctx, {
    action: 'identity.link_started',
    resourceType: 'member',
    resourceId: memberId,
    details: { provider: GOOGLE_PROVIDER, expected_email: member.email, scopes: input.scopes },
  });
  return { expectedEmail: member.email, domain: org.domain, expiresAt };
}

/**
 * Load and use up a link request (single use, 10 minutes). Run it in its own
 * transaction so the request stays consumed even when a later check fails: a code can
 * never be replayed. The caller then checks the same admin finished it.
 */
export async function consumeLinkRequest(
  trx: Tx,
  stateHash: string,
  now: Date = new Date(),
): Promise<OauthLinkRequest> {
  const request = await trx
    .selectFrom('workforce.oauth_link_requests')
    .selectAll()
    .where('state_hash', '=', stateHash)
    .forUpdate()
    .executeTakeFirst();
  if (!request || request.consumed_at || new Date(request.expires_at) <= now) {
    throw linkError('link_expired');
  }
  await trx
    .updateTable('workforce.oauth_link_requests')
    .set({ consumed_at: now })
    .where('state_hash', '=', stateHash)
    .execute();
  return request;
}

/** The admin who started the sign-in must be the one finishing it (login CSRF guard). */
export function checkLinkRequester(request: OauthLinkRequest, actorMemberId: string): void {
  if (request.created_by !== actorMemberId) throw linkError('session_mismatch');
}

/** What the web process verified from Google's signed ID token and token response. */
export interface VerifiedGoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  /** Workspace domain (`hd` claim); absent for personal accounts. */
  hostedDomain: string | null;
  grantedScopes: string[];
}

/** Google returns long names for the identity scopes. */
const SCOPE_ALIASES: Record<string, string> = {
  'https://www.googleapis.com/auth/userinfo.email': 'email',
  'https://www.googleapis.com/auth/userinfo.profile': 'profile',
};

export function missingScopes(requested: readonly string[], granted: readonly string[]): string[] {
  const have = new Set(granted.map((s) => SCOPE_ALIASES[s] ?? s));
  return requested.filter((s) => !have.has(SCOPE_ALIASES[s] ?? s));
}

/**
 * Check the signed-in account against the request (flow B, step 6). Throws an
 * IdentityLinkError with the fix for the admin. Nothing is stored here.
 */
export async function checkLinkedIdentity(
  trx: Tx,
  ctx: ActorContext,
  request: OauthLinkRequest,
  identity: VerifiedGoogleIdentity,
): Promise<void> {
  if (!identity.emailVerified) throw linkError('email_unverified');
  if (!identity.hostedDomain) throw linkError('not_workspace');
  const org = await getOrganization(trx, ctx.orgId);
  const hd = identity.hostedDomain.toLowerCase();
  if (hd !== org.domain && !hd.endsWith(`.${org.domain}`)) throw linkError('wrong_domain');
  const email = identity.email.toLowerCase();
  if (email !== request.expected_email) {
    throw linkError('wrong_account', `Sign in as ${request.expected_email}.`);
  }
  const member = await loadAi(trx, request.member_id);
  if (member.status !== 'external_identity_pending') throw linkError('invalid_state');
  if (missingScopes(request.requested_scopes, identity.grantedScopes).length > 0) {
    throw linkError('scopes_missing');
  }
  const taken = await trx
    .selectFrom('workforce.external_identities')
    .select('member_id')
    .where('provider', '=', GOOGLE_PROVIDER)
    .where('provider_user_id', '=', identity.sub)
    .where('connection_status', 'in', ['connected', 'reauth_required'])
    .executeTakeFirst();
  if (taken && taken.member_id !== request.member_id) throw linkError('already_linked');
}

/**
 * Save the verified identity and move the employee to identity_connected (flow B,
 * step 6). Call after checkLinkedIdentity, in the same transaction.
 */
export async function saveLinkedIdentity(
  trx: Tx,
  ctx: ActorContext,
  request: OauthLinkRequest,
  identity: VerifiedGoogleIdentity,
  credentialRef: string | null,
  now: Date = new Date(),
): Promise<ExternalIdentity> {
  let saved: ExternalIdentity;
  try {
    saved = await trx
      .insertInto('workforce.external_identities')
      .values({
        org_id: ctx.orgId,
        member_id: request.member_id,
        provider: GOOGLE_PROVIDER,
        provider_user_id: identity.sub,
        email_address: identity.email.toLowerCase(),
        hosted_domain: identity.hostedDomain,
        granted_scopes: identity.grantedScopes,
        credential_ref: credentialRef,
        last_verified_at: now,
        connected_at: now,
        created_by: ctx.actorMemberId,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    // Linked elsewhere between the check and the insert, possibly in another organization.
    if (isUniqueViolation(err)) throw linkError('already_linked');
    throw err;
  }
  await recordChange(
    trx,
    ctx,
    {
      action: 'identity.linked',
      resourceType: 'member',
      resourceId: request.member_id,
      details: {
        identity_id: saved.id,
        provider: GOOGLE_PROVIDER,
        email: saved.email_address,
        hosted_domain: saved.hosted_domain,
        scopes: saved.granted_scopes,
      },
    },
    {
      type: 'ExternalIdentityLinked',
      aggregateType: 'member',
      aggregateId: request.member_id,
      data: { identity_id: saved.id, provider: GOOGLE_PROVIDER },
    },
  );
  const member = await loadAi(trx, request.member_id);
  await transition(trx, ctx, member, 'identity_connected', { reason: 'identity_linked' });
  return saved;
}

/** Audit a failed link (flow B failure outcomes). The employee's state is unchanged. */
export async function recordLinkFailure(
  trx: Tx,
  ctx: ActorContext,
  memberId: string,
  code: LinkErrorCode,
  details: Record<string, unknown> = {},
): Promise<void> {
  await recordChange(
    trx,
    ctx,
    {
      action: 'identity.link_failed',
      resourceType: 'member',
      resourceId: memberId,
      outcome: 'failure',
      details: { provider: GOOGLE_PROVIDER, code, ...details },
    },
    {
      type: 'ExternalIdentityVerificationFailed',
      aggregateType: 'member',
      aggregateId: memberId,
      data: { provider: GOOGLE_PROVIDER, code },
    },
  );
}

/** Where a disconnected employee goes (flow D): back to waiting, or suspended if working. */
const AFTER_DISCONNECT: Partial<Record<AiState, AiState>> = {
  identity_connected: 'external_identity_pending',
  integrations_pending: 'external_identity_pending',
  permissions_configured: 'external_identity_pending',
  environment_ready: 'external_identity_pending',
  onboarding_failed: 'external_identity_pending',
  active: 'suspended',
};

/**
 * Unlink an identity (flow D). Returns the credential reference so the caller can
 * revoke the token at Google and delete the secret. The employee, its memory and its
 * history are untouched.
 */
export async function disconnectIdentity(
  trx: Tx,
  ctx: ActorContext,
  actor: Member | null,
  memberId: string,
  identityId: string,
  reason: 'manual' | 'terminated',
  now: Date = new Date(),
): Promise<{ identity: ExternalIdentity; credentialRef: string | null }> {
  if (actor) requireAdmin(actor);
  const member = await loadAi(trx, memberId);
  const identity = await trx
    .selectFrom('workforce.external_identities')
    .selectAll()
    .where('id', '=', identityId)
    .where('member_id', '=', memberId)
    .executeTakeFirst();
  if (!identity) throw new WorkforceError('not_found', 'Linked account not found');
  if (identity.connection_status === 'disconnected') {
    throw new WorkforceError('invalid_state', 'This account is already disconnected');
  }
  const updated = await trx
    .updateTable('workforce.external_identities')
    .set({
      connection_status: 'disconnected',
      disconnected_at: now,
      credential_ref: null,
      updated_at: now,
    })
    .where('id', '=', identityId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordChange(
    trx,
    ctx,
    {
      action: 'identity.disconnected',
      resourceType: 'member',
      resourceId: memberId,
      details: { identity_id: identityId, email: identity.email_address, reason },
    },
    {
      type: 'ExternalIdentityDisconnected',
      aggregateType: 'member',
      aggregateId: memberId,
      data: { identity_id: identityId, reason },
    },
  );
  const next = reason === 'manual' ? AFTER_DISCONNECT[member.status as AiState] : undefined;
  if (next) {
    await transition(trx, ctx, member, next, {
      reason: 'identity_disconnected',
      ...(next === 'suspended' ? { suspensionReason: 'identity_revoked' as const } : {}),
    });
  }
  return { identity: updated, credentialRef: identity.credential_ref };
}

/**
 * The OnboardingWorkflow's first automatic step: a linked employee moves on to
 * connecting its tools. Safe to run twice.
 */
export async function continueOnboarding(
  trx: Tx,
  ctx: ActorContext,
  memberId: string,
): Promise<AiState> {
  const member = await loadAi(trx, memberId);
  if (member.status !== 'identity_connected') return member.status as AiState;
  const after = await transition(trx, ctx, member, 'integrations_pending', {
    reason: 'identity_linked',
  });
  return after.status as AiState;
}
