import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';

/**
 * Shared base for the two Q&A agents (`find-patient.agent.ts` and `answer-patient.agent.ts`):
 * the OpenAI chat client, conversation-history hardening, token-usage extraction, and the safe
 * fallback string. Kept agent-agnostic so neither agent depends on the other — both import from
 * here. Nest-free (Studio graph and scripts reuse it too).
 */

/**
 * Safe fallback string (used verbatim per the spec) for when no patient can be resolved or a
 * question can't be answered from the records. `QaService` returns this whenever extraction yields
 * nothing routable, a retrieval matches nothing, an answer isn't grounded, or anything fails.
 */
export const SAFE_FALLBACK =
  'I cannot find a matching patient in your cohort, or I cannot answer this question based on the available records.';

/**
 * One prior conversation turn the client sends so an agent can resolve follow-ups ("what about his
 * allergies?"). Only `user`/`assistant` are accepted; assistant content is a COMPACT summary or
 * answer text (see `QaResult.contextSummary` / the answer path), never a full patient record.
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Keep at most this many prior turns (history is for coreference, not full recall). */
const MAX_HISTORY_TURNS = 6;
/** Cap any single turn's content to bound tokens + injection surface. */
const MAX_CONTENT_CHARS = 500;

/**
 * Harden client-supplied history before it reaches any model:
 *   • whitelist roles to user/assistant (drops any injected `system`/`tool` turn),
 *   • coerce content to a trimmed, length-capped string,
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
        typeof turn.content === 'string' &&
        turn.content.trim().length > 0,
    )
    .map((turn) => ({
      role: turn.role,
      content: turn.content.trim().slice(0, MAX_CONTENT_CHARS),
    }))
    .slice(-MAX_HISTORY_TURNS);
}

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

/** Default chat model + sampling; overridable via ConfigService at the DI layer. */
export const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
export const DEFAULT_CHAT_TEMPERATURE = 0;
// Client-side resilience so a slow/stalled OpenAI call fails FAST into the safe-fallback path
// instead of inheriting the SDK's ~10-minute default and fanning out unbounded under load. Worst-
// case wall time ≈ timeout × (1 + maxRetries), so keep retries low.
const CHAT_TIMEOUT_MS = 15_000;
const CHAT_MAX_RETRIES = 2;
const CHAT_MAX_CONCURRENCY = 8;

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
