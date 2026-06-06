import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isCohortGroup, type CohortGroup } from './cohort.types';

/**
 * Mints and verifies the session token that carries the active cohort.
 *
 * The token is a JWT signed with `JWT_SECRET` whose only meaningful claim is `{ group }`.
 * Signing is the safety-relevant choice: the cohort is tamper-proof, so a client cannot widen
 * its own access by editing the header. The backend stays stateless — there is no session store;
 * everything needed to authorize a request travels (signed) in the token.
 *
 * Transport is HTTP Basic auth (per the spec). We wrap the JWT as the Basic credential
 * `base64("<jwt>:")` (jwt = username, empty password) so the client can drop it straight into
 * `Authorization: Basic <token>` without knowing anything about JWTs or base64.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly jwt: JwtService) {}

  /** Issue a session token for a freshly selected cohort. */
  async mintToken(group: CohortGroup): Promise<string> {
    const jwt = await this.jwt.signAsync({ group });
    return Buffer.from(`${jwt}:`).toString('base64');
  }

  /**
   * Resolve (and verify) the active cohort from an `Authorization` header. The returned group is
   * read ONLY from the verified JWT claims — never from the unsigned username portion. Any
   * problem (missing header, wrong scheme, bad base64, invalid/expired signature, bad claim)
   * collapses to a single 401 so the failure mode can't be probed.
   */
  async resolveGroup(authHeader?: string): Promise<CohortGroup> {
    if (!authHeader?.startsWith('Basic ')) {
      throw new UnauthorizedException('Missing session token');
    }
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      // Basic credential is `<jwt>:` — the JWT is everything before the FIRST colon.
      const jwt = decoded.slice(0, decoded.indexOf(':'));
      const payload = await this.jwt.verifyAsync<{ group?: unknown }>(jwt);
      if (!isCohortGroup(payload.group)) {
        throw new UnauthorizedException('Invalid cohort in token');
      }
      return payload.group;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid session token');
    }
  }
}
