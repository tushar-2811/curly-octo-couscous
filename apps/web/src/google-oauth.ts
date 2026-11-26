import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Google OAuth 2.0 / OpenID Connect for linking an AI employee's account
 * (Identity linking §4, flow B). Behind an interface so tests use a fake Google.
 * Tokens are returned to the caller and never logged.
 */
export interface GoogleOAuth {
  authorizationUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
    scopes: readonly string[];
    loginHint: string;
    hostedDomain: string;
  }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokens>;
  verifyIdToken(idToken: string): Promise<GoogleIdClaims>;
  /** Test call as the account: returns the `sub` Google's userinfo reports. */
  userInfoSubject(accessToken: string): Promise<string>;
  /** Revoke a refresh or access token at Google. */
  revoke(token: string): Promise<void>;
}

export interface GoogleTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
}

export interface GoogleIdClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  hostedDomain: string | null;
  nonce: string | null;
}

/** A failed call to Google. `oauthError` is Google's error code, e.g. invalid_grant. */
export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    public readonly oauthError: string | null,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const TIMEOUT_MS = 10_000;

export class HttpGoogleOAuth implements GoogleOAuth {
  private readonly jwks: JWTVerifyGetKey;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {
    this.jwks = createRemoteJWKSet(new URL(JWKS_URL));
  }

  authorizationUrl(p: Parameters<GoogleOAuth['authorizationUrl']>[0]): string {
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: p.scopes.join(' '),
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      // A refresh token every time, and the account picker so the admin can switch
      // from their own account to the employee's.
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      login_hint: p.loginHint,
      hd: p.hostedDomain,
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokens> {
    const body = await this.post(TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
    });
    if (typeof body.id_token !== 'string' || typeof body.access_token !== 'string') {
      throw new GoogleOAuthError('Google returned no ID token', null, null);
    }
    return {
      idToken: body.id_token,
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
    };
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdClaims> {
    // Signature against Google's published keys, issuer, audience and expiry.
    const { payload } = await jwtVerify(idToken, this.jwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: this.clientId,
    });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw new GoogleOAuthError('ID token has no subject or email', null, null);
    }
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      hostedDomain: typeof payload.hd === 'string' ? payload.hd : null,
      nonce: typeof payload.nonce === 'string' ? payload.nonce : null,
    };
  }

  async userInfoSubject(accessToken: string): Promise<string> {
    const res = await fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new GoogleOAuthError('Userinfo call failed', null, res.status);
    const body = (await res.json()) as { sub?: unknown };
    if (typeof body.sub !== 'string') throw new GoogleOAuthError('Userinfo has no sub', null, null);
    return body.sub;
  }

  async revoke(token: string): Promise<void> {
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 400 invalid_token means it is already revoked or expired: the goal is met.
    if (!res.ok && res.status !== 400) {
      throw new GoogleOAuthError('Token revocation failed', null, res.status);
    }
  }

  private async post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof body.error === 'string' ? body.error : null;
      throw new GoogleOAuthError(`Google token endpoint returned ${res.status}`, code, res.status);
    }
    return body;
  }
}
