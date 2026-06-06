import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { isAgentVariant, type AgentVariant } from './variant.types';

/**
 * Injects the A/B variant that {@link CohortAuthGuard} resolved from the verified token and stashed on
 * the request. Unlike {@link ActiveCohort}, a missing value here is NOT a security failure — the
 * variant is an experiment dimension — so we defensively default to the 'structured' control arm
 * rather than throwing. (The guard always sets it for non-`@Public()` routes; the default just guards
 * against an unexpected gap, keeping behavior on the safe, well-tested arm.)
 */
export const ActiveVariant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AgentVariant => {
    const req = ctx.switchToHttp().getRequest<{ variant?: AgentVariant }>();
    return isAgentVariant(req.variant) ? req.variant : 'structured';
  },
);
