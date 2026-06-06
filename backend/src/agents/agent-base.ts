import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';

/**
 * Shared base for the two Q&A agents (`find-patient.agent.ts` and `answer-patient.agent.ts`):
 * the OpenAI chat client, conversation-history hardening, token-usage extraction, and the safe
 * fallback string. Kept agent-agnostic so neither agent depends on the other — both import from
 * here. Nest-free (Studio graph and scripts reuse it too).
 */

// ───────────────────────────────── constants ─────────────────────────────────

/**
 * The find-patient fallback string (used verbatim per the spec). `QaService` returns this on the
 * FIND path (extraction yields nothing routable / a retrieval matches nothing) and, critically, on
 * the answer path's COHORT-BOUNDARY block — an unknown or cross-cohort patient id must stay
 * indistinguishable, so that case keeps this exact wording. A grounded answer the answerer simply
 * can't support uses the friendlier {@link ANSWER_FALLBACK} instead.
 */
export const FIND_PATIENT_FALLBACK =
  'I cannot find a matching patient in your cohort, or I cannot answer this question based on the available records.';

/**
 * Friendlier fallback for the ANSWER path: a patient is already resolved, so the find-style
 * "…in your cohort…" wording is both wrong and needlessly cold. Used when the answerer can't ground
 * a reply in THIS patient's records (records silent, off-topic, or an injection refusal) or hits a
 * generic error. NOT used for the cohort-boundary block — that stays the verbatim {@link
 * FIND_PATIENT_FALLBACK} so a foreign/unknown id can't be told apart.
 */
export const ANSWER_FALLBACK =
  "I can't find that information in this patient's records. Is there anything else I can help you with?";

/** Keep at most this many prior turns — generous so the agent has the full conversation context,
 *  while still bounding token spend + injection surface on a long chat. */
const MAX_HISTORY_TURNS = 20;
/** Cap any single turn's content to bound tokens + injection surface. */
const MAX_CONTENT_CHARS = 2000;

/**
 * Our own context-window budget (tokens) for the chat-window usage meter — a single tunable constant,
 * deliberately NOT the model's true context limit. Change it here to move the meter's % baseline.
 */
export const CONTEXT_WINDOW_TOKENS = 100_000;

/** Default chat model + sampling; overridable via ConfigService at the DI layer. */
export const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
export const DEFAULT_CHAT_TEMPERATURE = 0;

// Client-side resilience so a slow/stalled OpenAI call fails FAST into the safe-fallback path
// instead of inheriting the SDK's ~10-minute default and fanning out unbounded under load. Worst-
// case wall time ≈ timeout × (1 + maxRetries), so keep retries low.
const CHAT_TIMEOUT_MS = 15_000;
const CHAT_MAX_RETRIES = 2;
const CHAT_MAX_CONCURRENCY = 8;

// ──────────────────────────── conversation history ───────────────────────────

/**
 * Which agent/phase produced a conversation turn. The client tags every history turn with this so the
 * answer-patient agent can be fed ONLY its own (answer-phase) turns — never the find-phase chatter
 * (searches / candidate lists about OTHER patients). See {@link answerHistoryForPatient}.
 */
export type AgentName = 'find-patient' | 'answer-patient';

/**
 * One prior conversation turn the client sends so an agent can resolve follow-ups ("what about his
 * allergies?"). Only `user`/`assistant` are accepted; assistant content is a COMPACT summary or
 * answer text (see `QaResult.contextSummary` / the answer path), never a full patient record.
 *
 * `agentName` is REQUIRED — every history turn declares the phase that produced it, which is the
 * routing contract the answer-patient scoping relies on. `patientId` is set only on answer-phase
 * turns (the patient that turn is about), so the answerer can keep only the active patient's turns.
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  agentName: AgentName;
  patientId?: string;
}

/** True for the two valid agent tags — used to drop untagged/legacy turns during hardening. */
function isAgentName(value: unknown): value is AgentName {
  return value === 'find-patient' || value === 'answer-patient';
}

/**
 * Harden client-supplied history before it reaches any model:
 *   • whitelist roles to user/assistant (drops any injected `system`/`tool` turn),
 *   • require a valid `agentName` (drops untagged/legacy turns — every real turn is phase-tagged),
 *   • coerce content to a trimmed, length-capped string,
 *   • carry `agentName` through and preserve a non-empty `patientId` (for answer-phase scoping),
 *   • keep only the most recent MAX_HISTORY_TURNS.
 * Each agent still prepends its OWN trusted system prompt, so a poisoned history can at most nudge
 * the extracted fields / answer — it can never replace the instructions or bypass routing.
 */
export function sanitizeAndTrim(history: ChatTurn[] | undefined): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (turn): turn is ChatTurn =>
        !!turn &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        isAgentName(turn.agentName) &&
        typeof turn.content === 'string' &&
        turn.content.trim().length > 0,
    )
    .map((turn) => ({
      role: turn.role,
      content: turn.content.trim().slice(0, MAX_CONTENT_CHARS),
      agentName: turn.agentName,
      ...(typeof turn.patientId === 'string' && turn.patientId.trim().length > 0
        ? { patientId: turn.patientId }
        : {}),
    }))
    .slice(-MAX_HISTORY_TURNS);
}

/**
 * The answer-phase turns about ONE patient — exactly what the answer-patient agent should see, and
 * nothing from the find phase or about any other patient. Untagged turns are excluded by
 * construction (they fail the `agentName` test). Filters on the raw client history; the agent
 * re-runs {@link sanitizeAndTrim} on the result.
 */
export function answerHistoryForPatient(
  history: ChatTurn[] | undefined,
  patientId: string,
): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  return history.filter((t) => t?.agentName === 'answer-patient' && t.patientId === patientId);
}

// ─────────────────────────────── token usage ─────────────────────────────────

/** Token usage for one model call (best-effort; surfaced for observability). */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Pull token usage off the raw AIMessage (`usage_metadata`), if present. */
export function readUsage(raw: BaseMessage): TokenUsage | undefined {
  const usage = (raw as AIMessage).usage_metadata;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

/**
 * Best-effort RAW model output for the audit log. Under OpenAI strict structured-outputs the textual
 * `content` is usually empty and the structured payload rides in the tool call, so fall back to the
 * first tool call's args. Returns undefined when nothing usable is present (no model call / refusal
 * with no content).
 */
export function rawContentToString(raw: BaseMessage): string | undefined {
  const msg = raw as AIMessage;
  if (typeof msg.content === 'string' && msg.content.trim().length > 0) return msg.content;
  if (Array.isArray(msg.content) && msg.content.length > 0) return JSON.stringify(msg.content);
  const toolArgs = msg.tool_calls?.[0]?.args;
  if (toolArgs !== undefined) return JSON.stringify(toolArgs);
  return undefined;
}

// ─────────────────────────────── trace context ───────────────────────────────

/**
 * Per-request observability context an agent stamps onto its model call. Recorded in the audit log
 * AND — when LANGSMITH_TRACING is on — forwarded to LangSmith as tags/metadata (see
 * {@link buildRunConfig}), so the find-patient vs answer-patient runs are filterable by agent,
 * cohort, and correlation id.
 */
export interface TraceContext {
  traceId?: string;
  cohort?: string;
}

/**
 * Build the {@link RunnableConfig} for an agent's `.invoke()` so its run is NAMED and TAGGED by agent
 * (+ cohort / traceId). Purely observability — it does not change the model output, and when
 * LANGSMITH_TRACING is off the fields are simply ignored. This is what lets the two agents be
 * traced/filtered separately in LangSmith (`agent:find-patient` / `agent:answer-patient`).
 */
export function buildRunConfig(agentName: string, ctx?: TraceContext): RunnableConfig {
  const tags = ['patients-qa', `agent:${agentName}`];
  if (ctx?.cohort) tags.push(`cohort:${ctx.cohort}`);
  return {
    runName: agentName,
    tags,
    metadata: {
      agent: agentName,
      ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
      ...(ctx?.cohort ? { cohort: ctx.cohort } : {}),
    },
  };
}

/**
 * Per-request token usage surfaced to the client (extends {@link TokenUsage} with the model name and
 * the context-window budget the UI charts the conversation against). The service composes this from
 * the agent's best-effort {@link TokenUsage} plus the resolved model.
 */
export interface RequestUsage extends TokenUsage {
  model: string;
  contextWindow: number;
}

// ──────────────────────────────── chat model ─────────────────────────────────

/** Tuning knobs for the chat model (model + temperature); resilience is fixed in {@link createChatModel}. */
export interface ChatModelOptions {
  model?: string;
  temperature?: number;
}

/**
 * Single place the OpenAI chat client is constructed (both agents + the Studio graph), so the model
 * name, temperature, and resilience config live in ONE spot. Undefined options fall back to the
 * defaults. Reads OPENAI_API_KEY from the environment.
 */
export function createChatModel(options: ChatModelOptions = {}): ChatOpenAI {
  return new ChatOpenAI({
    model: options.model ?? DEFAULT_CHAT_MODEL,
    temperature: options.temperature ?? DEFAULT_CHAT_TEMPERATURE,
    timeout: CHAT_TIMEOUT_MS,
    maxRetries: CHAT_MAX_RETRIES,
    maxConcurrency: CHAT_MAX_CONCURRENCY,
  });
}
