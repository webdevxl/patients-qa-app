import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { isCohortGroup, type CohortGroup } from './cohort.types';
import { assignVariant, isAgentVariant, type AgentVariant } from './variant.types';

/**
 * The verified session a request operates under: the safety-relevant `group` plus the A/B `variant`.
 * Both are read ONLY from the signed token claims.
 */
export interface SessionContext {
  group: CohortGroup;
  variant: AgentVariant;
}

/**
 * Mints and verifies the session token that carries the active cohort AND the A/B variant.
 *
 * The token is a JWT signed with `JWT_SECRET` whose claims are `{ group, variant, sid }`. Signing is
 * the safety-relevant choice: the cohort is tamper-proof, so a client cannot widen its own access by
 * editing the header — and, as a bonus, cannot move itself onto the other experiment arm either. The
 * backend stays stateless — there is no session store; everything needed to authorize a request and
 * route it to its variant travels (signed) in the token.
 *
 * Transport is HTTP Basic auth (per the spec). We wrap the JWT as the Basic credential
 * `base64("<jwt>:")` (jwt = username, empty password) so the client can drop it straight into
 * `Authorization: Basic <token>` without knowing anything about JWTs or base64.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly jwt: JwtService) {}

  /**
   * Issue a session token for a freshly selected cohort. The A/B `variant` is normally assigned here
   * — deterministically from a fresh per-session id (`sid`), so the split is even and independent of
   * cohort, and stable for the session's lifetime because it's baked into the signed token. An
   * explicit `variant` (the eval/test override) pins the arm instead of hashing.
   */
  async mintToken(group: CohortGroup, variant?: AgentVariant): Promise<SessionContext & { token: string }> {
    const sid = randomUUID();
    const assigned = variant ?? assignVariant(sid);
    const jwt = await this.jwt.signAsync({ group, variant: assigned, sid });
    return { token: Buffer.from(`${jwt}:`).toString('base64'), group, variant: assigned };
  }

  /**
   * Resolve (and verify) the active session from an `Authorization` header. The group + variant are
   * read ONLY from the verified JWT claims — never from the unsigned username portion. Any problem
   * (missing header, wrong scheme, bad base64, invalid/expired signature, bad group claim) collapses
   * to a single 401 so the failure mode can't be probed. A missing/invalid `variant` claim is NOT a
   * failure — older tokens predate the A/B test, so we default them to the 'structured' control arm.
   */
  async resolveSession(authHeader?: string): Promise<SessionContext> {
    if (!authHeader?.startsWith('Basic ')) {
      throw new UnauthorizedException('Missing session token');
    }
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      // Basic credential is `<jwt>:` — the JWT is everything before the FIRST colon.
      const jwt = decoded.slice(0, decoded.indexOf(':'));
      const payload = await this.jwt.verifyAsync<{ group?: unknown; variant?: unknown }>(jwt);
      if (!isCohortGroup(payload.group)) {
        throw new UnauthorizedException('Invalid cohort in token');
      }
      // `variant` is an experiment dimension, not a security boundary: tolerate its absence (legacy
      // tokens) by falling back to the control arm rather than rejecting the request.
      const variant = isAgentVariant(payload.variant) ? payload.variant : 'structured';
      return { group: payload.group, variant };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid session token');
    }
  }
}
