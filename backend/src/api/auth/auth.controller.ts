import { BadRequestException, Body, Controller, Logger, Post } from '@nestjs/common';
import { AuthService } from '../../shared/security/auth.service';
import { Public } from '../../shared/security/public.decorator';
import { isCohortGroup, type CohortGroup } from '../../shared/security/cohort.types';

/**
 * The one route exempt from auth (`@Public()`): the clinician picks a cohort and gets back a
 * session token to use on every subsequent request. This simulates account-level access control
 * without a full sign-up flow — choosing a group here is what grants access to that group's data.
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('session')
  async createSession(
    @Body() body: { group?: unknown },
  ): Promise<{ token: string; group: CohortGroup }> {
    if (!isCohortGroup(body.group)) {
      throw new BadRequestException("group must be 'A' or 'B'");
    }
    const token = await this.auth.mintToken(body.group);
    this.logger.log(`🔑 session issued for cohort ${body.group}`);
    return { token, group: body.group };
  }
}
