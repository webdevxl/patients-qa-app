import { createHash } from 'node:crypto';

/**
 * The A/B EXPERIMENT dimension — NOT a security boundary (unlike {@link CohortGroup}). It selects
 * which agent ARCHITECTURE answers a request:
 *   • 'structured'   — the control: find-patient extracts a fixed schema (`withStructuredOutput`) and
 *                      code routes the retrieval; answer-patient is a zero-tool structured-output agent.
 *   • 'tool_calling' — the LLM drives retrieval/record-loading itself by CALLING a LangChain tool
 *                      (the classic agent loop), then the same downstream shaping runs.
 *
 * Both variants share the IDENTICAL cohort-isolation + injection defenses (the tools are bound to the
 * caller's group; the answer path's cohort re-verify is untouched), so the variant only changes HOW
 * the model is driven, never WHAT data it can reach.
 *
 * The variant is assigned once per session and travels in the SIGNED session token (like `group`), so
 * it is stable for the whole session and a client cannot spoof its way onto the other arm. Kept here,
 * next to {@link cohort.types}, because both are token claims the guard resolves — even though only
 * `group` is safety-relevant.
 */
export type AgentVariant = 'structured' | 'tool_calling';

/** The two arms, in one place — handy for iterating in the metrics aggregation and eval. */
export const AGENT_VARIANTS: readonly AgentVariant[] = ['structured', 'tool_calling'];

/** Runtime narrowing for untrusted input (request bodies, decoded token claims). */
export function isAgentVariant(value: unknown): value is AgentVariant {
  return value === 'structured' || value === 'tool_calling';
}

/**
 * Deterministic 50/50 assignment from a stable seed (a freshly-minted per-session id). Hashing keeps
 * the split even and reproducible: the SAME seed always lands on the SAME arm, so re-deriving from the
 * token is consistent, while different sessions spread across both arms independently of cohort. The
 * low bit of a SHA-256 digest is an unbiased coin over arbitrary seeds.
 */
export function assignVariant(seed: string): AgentVariant {
  const firstByte = createHash('sha256').update(seed).digest()[0] ?? 0;
  return firstByte % 2 === 0 ? 'structured' : 'tool_calling';
}
