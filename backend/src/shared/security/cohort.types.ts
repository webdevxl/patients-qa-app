// The cohort is the app's central safety boundary. There are exactly two cohorts, and a
// request operates inside exactly one of them — resolved from the verified session token,
// never asserted by the client body. Keep this the single source of truth for the type so
// the guard, the retrieval layer, and the controllers all agree on what a valid group is.

export type CohortGroup = 'A' | 'B';

/** Runtime narrowing for untrusted input (request bodies, decoded token claims). */
export function isCohortGroup(value: unknown): value is CohortGroup {
  return value === 'A' || value === 'B';
}
