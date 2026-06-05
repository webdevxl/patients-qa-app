import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { CohortGroup } from './cohort.types';

/**
 * Deny-by-default authentication. Registered globally (APP_GUARD), so every route requires a
 * valid session token UNLESS marked `@Public()`. On success it stashes the verified cohort on
 * `request.cohort`, which `@ActiveCohort()` reads downstream — the resolved group enters the
 * system here, once, from a trusted source.
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

    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; cohort?: CohortGroup }>();
    // Throws UnauthorizedException (→ 401) on any failure.
    req.cohort = await this.auth.resolveGroup(req.headers.authorization);
    return true;
  }
}
