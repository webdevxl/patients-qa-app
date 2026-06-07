import type { FindPatientsResult } from './tools/find-patients.tool';
import type { ChatTurn, TokenUsage, TraceContext } from './agent-base';
import type { CohortGroup } from '../../shared/security/cohort.types';
import type { AgentVariant } from '../../shared/security/variant.types';

/**
 * The shared FIND seam — the variant-agnostic contract both A/B arms implement so `QaService` runs a
 * single code path. A resolver takes the clinician's question + history and returns the SAME
 * {@link FindResolution} the downstream shaping already expects — only HOW it gets there differs per
 * arm (structured extraction vs. an LLM-driven `find_patients` tool call). Each arm's resolver lives
 * in its own variant folder (`variants/structured`, `variants/tool-calling`); this file holds only
 * what they have in common.
 *
 * Cohort isolation is identical on both arms: every read is scoped to the caller's `group` (the
 * structured arm via `findPatients(..., group)`, the tool arm by binding the tool to `group`), so
 * neither resolver can reach another cohort.
 */

/** Nest DI token: a map of both arms' find resolvers, selected per request by the session variant. */
export const FIND_PATIENT_RESOLVERS = Symbol('FIND_PATIENT_RESOLVERS');

/** Both arms' resolvers, keyed by variant — what `QaService` injects and indexes. */
export type FindPatientResolvers = Record<AgentVariant, FindPatientResolver>;

/** Normalized result of the FIND stage — variant-agnostic, so downstream shaping never branches. */
export interface FindResolution {
  retrieval: FindPatientsResult;
  usage?: TokenUsage;
  /** Best-effort raw model output (extraction object / tool-call args) — for the audit log. */
  raw?: string;
  /** Structured-output refusal (the extractor's injection ceiling tripped). Only the structured arm. */
  refused?: boolean;
  /** Audit rationale for the search params (the extractor writes one; the tool arm has none). */
  reasoning?: string | null;
}

export interface FindPatientResolver {
  /** The resolved chat model name — surfaced so the service can report it in usage. */
  readonly model: string;
  resolve(
    question: string,
    history: ChatTurn[],
    group: CohortGroup,
    trace: TraceContext,
  ): Promise<FindResolution>;
}

/** Nothing resolved/matched — the fail-closed result that routes to the safe fallback. */
export const EMPTY_RETRIEVAL: FindPatientsResult = { query: {}, matchCount: 0 };
