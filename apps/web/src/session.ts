import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'aiw_session';

/**
 * What the session cookie carries. `sub` is the identity-provider subject (Google `sub`,
 * or `dev:<email>` locally). `mid`/`oid` are present once the person belongs to an org.
 * Membership and status are re-checked against the database on every request, so a
 * suspended member loses access immediately even with a valid cookie.
 */
export interface SessionClaims {
  sub: string;
  email: string;
  name: string;
  mid?: string;
  oid?: string;
}

export class SessionCodec {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlHours: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  get maxAgeSeconds(): number {
    return this.ttlHours * 3600;
  }

  async sign(claims: SessionClaims): Promise<string> {
    const { sub, ...rest } = claims;
    return new SignJWT({ ...rest })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuedAt()
      .setIssuer('aiw')
      .setAudience('aiw-dashboard')
      .setExpirationTime(`${this.ttlHours}h`)
      .sign(this.key);
  }

  /** Returns the claims, or undefined when the token is invalid or expired. */
  async verify(token: string): Promise<SessionClaims | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: 'aiw',
        audience: 'aiw-dashboard',
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return undefined;
      return {
        sub: payload.sub,
        email: payload.email,
        name: typeof payload.name === 'string' ? payload.name : payload.email,
        ...(typeof payload.mid === 'string' ? { mid: payload.mid } : {}),
        ...(typeof payload.oid === 'string' ? { oid: payload.oid } : {}),
      };
    } catch {
      return undefined;
    }
  }
}
