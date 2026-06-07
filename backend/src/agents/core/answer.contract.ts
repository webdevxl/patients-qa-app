import { z } from 'zod';
import type { ChatTurn, TokenUsage, TraceContext } from './agent-base';
import type { AgentVariant } from '../../shared/security/variant.types';

/**
 * The shared ANSWER contract — the variant-agnostic schema + interface both A/B arms implement. The
 * answerer composes a grounded prose ANSWER about ONE already-resolved patient. Each arm
 * (`variants/structured`, `variants/tool-calling`) builds its own {@link createAgent} with its own
 * prompt and response strategy, but BOTH emit exactly this {@link answerSchema} object and satisfy
 * the {@link AnswerPatientAgent} interface, so `QaService` consumes them identically.
 *
 * The fixed schema is the core injection ceiling: even if a record field carries "ignore your
 * instructions…", the worst the model can do is fill these fields. Cohort isolation is structural —
 * the patient was re-fetched under the caller's group before this layer runs, so it never sees
 * another cohort.
 */

/** Nest DI token for a single answer-patient agent (legacy single-arm wiring; kept for compatibility). */
export const ANSWER_PATIENT_AGENT = Symbol('ANSWER_PATIENT_AGENT');

/** Nest DI token: both A/B arms of the answer agent, keyed by variant — selected per request. */
export const ANSWER_PATIENT_AGENTS = Symbol('ANSWER_PATIENT_AGENTS');

/** Both arms' answer agents, keyed by variant — what `QaService` injects and indexes. */
export type AnswerPatientAgents = Record<AgentVariant, AnswerPatientAgent>;

/** The all-refused answer: nothing supportable → caller substitutes the safe fallback. */
export const UNANSWERABLE: PatientAnswer = {
  answerable: false,
  answer: '',
  confidence: 'Low',
  citations: [],
  reasoning: '',
};

/**
 * Confidence in the grounded answer. Mirrors the find agent / UI vocabulary so `MessageBubble`
 * renders it without translation.
 */
export type AnswerConfidence = 'High' | 'Medium' | 'Low';

/**
 * The fixed answer object. Unlike the extraction schema these keys are all REQUIRED and non-null,
 * so OpenAI strict structured-outputs is satisfied without `.nullable()`:
 *   • answerable — false when the records don't support an answer (or the message is off-topic /
 *     an injection attempt); the service then substitutes the friendlier ANSWER_FALLBACK.
 *   • answer     — concise grounded prose (only meaningful when answerable).
 *   • confidence — the model's own calibration over the supporting evidence.
 *   • citations  — the source-record labels ([C1], [M2], …) the answer relied on.
 */
export const answerSchema = z.object({
  answerable: z
    .boolean()
    .describe(
      'true when you can answer the latest message — either the patient record contains the ' +
        'clinical information asked for, OR it is a question about this conversation that the prior ' +
        'turns support (recalling what the user asked earlier, repeating your own previous answer, ' +
        'or resolving "the previous question"). false when neither holds — the caller then returns ' +
        'the safe fallback.',
    ),
  answer: z
    .string()
    .describe(
      "A concise answer (≤ ~80 words). Clinical facts must come from this one patient's record; a " +
        'conversational answer may recall or repeat what was already said in the prior turns. Empty ' +
        'string when answerable is false. Never speculate beyond the record.',
    ),
  confidence: z
    .enum(['High', 'Medium', 'Low'])
    .describe(
      'High = the record states it directly, or you are recalling the conversation exactly; ' +
        'Medium = inferred from related entries in the record; Low = weak/partial support. Use Low when answerable is false.',
    ),
  citations: z
    .array(z.string())
    .describe(
      'The source-record labels you used, exactly as bracketed in the record (e.g. "C1", "M2", ' +
        '"A1", "O3"). Empty array when answerable is false, and empty for a purely conversational ' +
        'answer that draws only on prior turns rather than the record.',
    ),
  // LAST in the schema on purpose: with providerStrategy json_schema, properties stream in declared
  // order. Keeping `reasoning` last means the streaming partial-parser surfaces `answerable` (the
  // gate) and `answer` (the prose) before any reasoning tokens — TTFT is unaffected. The audit log
  // captures reasoning from the final validated parse.
  reasoning: z
    .string()
    .describe(
      'Brief post-hoc rationale (1–3 sentences) for the audit log: which citations support which ' +
        'clauses of the answer, or which prior turn was recalled. When answerable is false, what ' +
        'was missing from the record. Empty string is allowed but discouraged. Never repeat the ' +
        'answer here.',
    ),
});

export type PatientAnswer = z.infer<typeof answerSchema>;

/** What the answer-patient agent returns: the parsed answer object, best-effort token usage, and a refusal flag. */
export interface PatientAnswerResult {
  result: PatientAnswer;
  /** Best-effort token usage. Absent on a structured-output PARSE-FAILURE refusal: providerStrategy
   *  throws {@link StructuredOutputParsingError}, which doesn't carry the generated message, so usage
   *  is unreachable there. The common "can't answer" case is `answerable:false` — which parses fine and
   *  DOES report usage/raw. */
  usage?: TokenUsage;
  /** True when the model refused / returned unparseable STRUCTURED output and we substituted
   *  {@link UNANSWERABLE}. NOT set for a hard infra error (timeout / network / 5xx) — that propagates
   *  so the service classifies it as `error`/high, never as an injection signal. */
  refused?: boolean;
  /** Best-effort raw model output (the json_schema content) — recorded in the audit log. Absent on a
   *  parse-failure refusal (see `usage`). */
  raw?: string;
}

export interface AnswerPatientAgent {
  /** The resolved chat model name (env override or default) — surfaced so the service can report it. */
  readonly model: string;
  answer(
    question: string,
    recordsContext: string,
    history?: ChatTurn[],
    trace?: TraceContext,
  ): Promise<PatientAnswerResult>;
  /**
   * Streaming twin of {@link answer}: same prompt, same schema, same authoritative parse — but the
   * agent is driven via `agent.stream` (streamMode `['messages','values']`), so the grounded answer
   * prose is surfaced token-by-token through `onToken` (cumulative answer-so-far) as it generates.
   * `onToken` is DISPLAY-ONLY; the returned {@link PatientAnswerResult} is always the validated
   * structured object (+ usage), never the streamed text — so a refusal/ungrounded turn streams
   * nothing and the recorded answer is unaffected by mid-stream rendering. (`history`/`trace` are
   * required here — a required `onToken` can't follow optional params; the caller always has both.)
   */
  answerStreaming(
    question: string,
    recordsContext: string,
    history: ChatTurn[],
    trace: TraceContext | undefined,
    onToken: (cumulativeAnswer: string) => void,
  ): Promise<PatientAnswerResult>;
}
