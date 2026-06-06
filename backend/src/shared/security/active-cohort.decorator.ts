import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { isCohortGroup, type CohortGroup } from './cohort.types';

/**
 * Injects the active cohort that {@link CohortAuthGuard} resolved from the verified token and
 * stashed on the request. Reaching a guarded handler without it set means the guard was
 * bypassed/misconfigured — fail loudly rather than silently defaulting to a cohort.
 */
export const ActiveCohort = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CohortGroup => {
    const req = ctx.switchToHttp().getRequest<{ cohort?: CohortGroup }>();
    // The guard sets `cohort`, but re-validate at runtime as defense-in-depth: an unset value
    // means the guard was bypassed/misconfigured, which must fail loudly rather than default.
    if (!isCohortGroup(req.cohort)) {
      throw new InternalServerErrorException('Active cohort not resolved');
    }
    return req.cohort;
  },
);
