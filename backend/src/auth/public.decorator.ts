import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as exempt from {@link CohortAuthGuard} (which is registered globally, so the
 * default is deny). Only the group-selection endpoint and the health/root probes use this —
 * everything else requires a valid session token.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
