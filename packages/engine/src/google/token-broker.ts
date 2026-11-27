import { withTenant, type Database, type Kysely } from '@aiw/db';
import type { Logger } from '@aiw/logger';
import { readSecret, recordChange, type SecretBox } from '@aiw/platform';
import { GoogleApiError } from './errors';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Renew this long before Google's expiry, so a call never starts with a dying token. */
const EARLY_MS = 2 * 60 * 1000;

export interface AccessToken {
  token: string;
  expiresAt: number;
  scopes: string[];
  identityId: string;
  email: string;
  /** Google account id (the OAuth `sub`), which is also the Chat user id. */
  googleUserId: string;
}

/**
 * Token broker (Phase 2 plan, slice 1). Turns an employee's stored, encrypted refresh token
 * into short-lived access tokens, cached in memory. If Google says the refresh token is no
 * longer valid (revoked, password changed, account suspended), the account is marked
 * "reconnect needed" and audited, so the dashboard asks an admin to link it again.
 */
export class GoogleTokenBroker {
  private readonly cache = new Map<string, AccessToken>();
  private readonly inflight = new Map<string, Promise<AccessToken>>();

  constructor(
    private readonly options: {
      db: Kysely<Database>;
      secrets: SecretBox;
      clientId: string;
      clientSecret: string;
      logger: Logger;
      fetch?: typeof fetch;
    },
  ) {}

  /** A valid access token for the employee's linked Google account. */
  async get(orgId: string, employeeId: string): Promise<AccessToken> {
    const cached = this.cache.get(employeeId);
    if (cached && cached.expiresAt - EARLY_MS > Date.now()) return cached;
    // One refresh at a time per employee, however many callers ask.
    const running = this.inflight.get(employeeId);
    if (running) return running;
    const p = this.refresh(orgId, employeeId).finally(() => this.inflight.delete(employeeId));
    this.inflight.set(employeeId, p);
    return p;
  }

  /** Forget the cached token, e.g. after Google rejected it with 401. */
  invalidate(employeeId: string): void {
    this.cache.delete(employeeId);
  }

  private async refresh(orgId: string, employeeId: string): Promise<AccessToken> {
    const { db, secrets, logger } = this.options;
    const loaded = await withTenant(db, orgId, async (trx) => {
      const identity = await trx
        .selectFrom('workforce.external_identities')
        .select(['id', 'email_address', 'provider_user_id', 'credential_ref', 'connection_status'])
        .where('member_id', '=', employeeId)
        .where('provider', '=', 'google_workspace')
        .where('connection_status', 'in', ['connected', 'reauth_required'])
        .orderBy('connected_at', 'desc')
        .executeTakeFirst();
      if (!identity) return null;
      const refreshToken = identity.credential_ref
        ? await readSecret(trx, secrets, identity.credential_ref)
        : null;
      return { identity, refreshToken };
    });
    if (!loaded) {
      throw new GoogleApiError('not_configured', 'The employee has no linked Google account');
    }
    const { identity, refreshToken } = loaded;
    if (identity.connection_status === 'reauth_required') {
      throw new GoogleApiError('reauth_required', 'The Google account needs to be linked again');
    }
    if (!refreshToken) {
      throw new GoogleApiError(
        'reauth_required',
        'No refresh token is stored; link the account again',
      );
    }

    const started = performance.now();
    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GoogleApiError('unavailable', 'Could not reach Google to refresh the token');
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const error = typeof body.error === 'string' ? body.error : `http_${res.status}`;
      if (error === 'invalid_grant' || error === 'unauthorized_client') {
        await this.markReauth(orgId, employeeId, identity.id, error);
        throw new GoogleApiError(
          'reauth_required',
          `Google refused the refresh token (${error})`,
          res.status,
        );
      }
      throw new GoogleApiError(
        res.status >= 500 ? 'unavailable' : 'bad_request',
        `Token refresh failed (${error})`,
        res.status,
      );
    }
    if (typeof body.access_token !== 'string') {
      throw new GoogleApiError('unavailable', 'Google returned no access token');
    }
    const token: AccessToken = {
      token: body.access_token,
      expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
      scopes: typeof body.scope === 'string' ? body.scope.split(' ') : [],
      identityId: identity.id,
      email: identity.email_address,
      googleUserId: identity.provider_user_id,
    };
    this.cache.set(employeeId, token);
    logger.info(
      {
        employee_id: employeeId,
        identity_id: identity.id,
        expires_in_s: Number(body.expires_in ?? 0),
        refresh_ms: Math.round(performance.now() - started),
      },
      'google access token refreshed',
    );
    return token;
  }

  private async markReauth(orgId: string, employeeId: string, identityId: string, reason: string) {
    this.invalidate(employeeId);
    try {
      await withTenant(this.options.db, orgId, async (trx) => {
        await trx
          .updateTable('workforce.external_identities')
          .set({
            connection_status: 'reauth_required',
            last_error: `Google refused the stored token (${reason}). Link the account again.`,
            updated_at: new Date(),
          })
          .where('id', '=', identityId)
          .where('connection_status', '=', 'connected')
          .execute();
        await recordChange(
          trx,
          { orgId, actorMemberId: null, requestId: null },
          {
            action: 'identity.reauth_required',
            resourceType: 'member',
            resourceId: employeeId,
            outcome: 'failure',
            details: { identity_id: identityId, reason },
          },
        );
      });
      this.options.logger.error(
        { employee_id: employeeId, identity_id: identityId, reason },
        'google refresh token rejected; account needs to be linked again',
      );
    } catch (err) {
      this.options.logger.error(
        { err, employee_id: employeeId },
        'could not mark identity for reauth',
      );
    }
  }
}
