// Frontend mirror of the backend's cohort model (`backend/src/agent/base/base-agent.ts`
// => `COHORT_GROUPS = ['A','B']`). Kept as a single source of truth so the picker,
// the chat header, and any future routing all agree on what a cohort is.
//
// Cohort population size is deliberately NOT surfaced to the client — it isn't
// sent by the backend and isn't shown in the picker.
import type { CohortGroup } from '../theme/palette';

export interface CohortMeta {
  group: CohortGroup;
  label: string;
  /** Short tagline shown under the title on the picker card. */
  caption: string;
  /** Ionicons glyph used as the cohort's mark. */
  icon: 'people' | 'people-circle';
}

export const COHORTS: readonly CohortMeta[] = [
  {
    group: 'A',
    label: 'Group A',
    caption: 'Cohort A patient records',
    icon: 'people',
  },
  {
    group: 'B',
    label: 'Group B',
    caption: 'Cohort B patient records',
    icon: 'people-circle',
  },
] as const;

export function cohortMeta(group: CohortGroup): CohortMeta {
  const found = COHORTS.find((c) => c.group === group);
  if (!found) throw new Error(`Unknown cohort group: ${group}`);
  return found;
}
