import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { CohortGroup } from './cohort.types';
import type { AgentVariant } from './variant.types';

/**
 * Deny-by-default authentication. Registered globally (APP_GUARD), so every route requires a
 * valid session token UNLESS marked `@Public()`. On success it stashes the verified cohort on
 * `request.cohort` (read by `@ActiveCohort()`) AND the A/B variant on `request.variant` (read by
 * `@ActiveVariant()`) — both resolved here, once, from the same trusted source (the signed token).
 */
@Injectable()
export class CohortAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string>;
      cohort?: CohortGroup;
      variant?: AgentVariant;
    }>();
    // Throws UnauthorizedException (→ 401) on any failure.
    const session = await this.auth.resolveSession(req.headers.authorization);
    req.cohort = session.group;
    req.variant = session.variant;
    return true;
  }
}
