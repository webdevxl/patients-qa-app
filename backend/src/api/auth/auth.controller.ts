import { BadRequestException, Body, Controller, Logger, Post } from '@nestjs/common';
import { AuthService } from '../../shared/security/auth.service';
import { Public } from '../../shared/security/public.decorator';
import { isCohortGroup, type CohortGroup } from '../../shared/security/cohort.types';
import { isAgentVariant, type AgentVariant } from '../../shared/security/variant.types';

/**
 * The one route exempt from auth (`@Public()`): the clinician picks a cohort and gets back a
 * session token to use on every subsequent request. This simulates account-level access control
 * without a full sign-up flow — choosing a group here is what grants access to that group's data.
 *
 * The A/B `variant` is assigned server-side (a deterministic per-session split) and returned for
 * visibility. An optional `variant` in the body is the EVAL/TEST override that pins the arm — handy
 * for exercising both variants within the same cohort. It weakens nothing: variant is not a security
 * boundary, and the token is still signed.
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('session')
  async createSession(
    @Body() body: { group?: unknown; variant?: unknown },
  ): Promise<{ token: string; group: CohortGroup; variant: AgentVariant }> {
    if (!isCohortGroup(body.group)) {
      throw new BadRequestException("group must be 'A' or 'B'");
    }
    if (body.variant !== undefined && !isAgentVariant(body.variant)) {
      throw new BadRequestException("variant must be 'structured' or 'tool_calling'");
    }
    const { token, group, variant } = await this.auth.mintToken(body.group, body.variant);
    this.logger.log(`🔑 session issued for cohort ${group} — variant ${variant}`);
    return { token, group, variant };
  }
}
