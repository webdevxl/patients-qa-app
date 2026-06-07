import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import { createAgent, providerStrategy } from 'langchain';
import {
  createChatModel,
  sanitizeAndTrim,
  readUsage,
  rawContentToString,
  buildRunConfig,
  DEFAULT_CHAT_MODEL,
  type ChatModelOptions,
  type ChatTurn,
  type TraceContext,
} from '../../core/agent-base';
import {
  answerSchema,
  UNANSWERABLE,
  type PatientAnswer,
  type PatientAnswerResult,
  type AnswerPatientAgent,
} from '../../core/answer.contract';
import {
  recordsUserPrompt,
  chunkContentToString,
  parsePartialAnswer,
  lastMessage,
  isStructuredOutputParseFailure,
} from '../../core/answer.shared';
import {
  injectionGuardMiddleware,
  injectionGuardContextSchema,
} from '../../../shared/security/injection-guard.middleware';
import type { InjectionGuardClassifier } from '../../../shared/security/injection-guard.classifier';

/**
 * The STRUCTURED A/B arm of the ANSWER stage — the control. A zero-tool {@link createAgent} whose
 * `responseFormat` is the provider-native ({@link providerStrategy}) {@link answerSchema}: the model
 * is boxed into exactly {answerable, answer, confidence, citations, reasoning} in ONE call, and the
 * JSON streams as message content (the streaming path reads it live). The ONE patient's record is
 * delivered inline as delimited DATA. The tool-calling arm of this same stage lives in
 * `variants/tool-calling/answer-patient.agent.ts`.
 *
 * Both arms share the IDENTICAL injection-guard middleware and structural cohort isolation (the
 * patient was re-fetched under the caller's group before this layer runs).
 */

// ─────────────────────────────────── prompt ─────────────────────────────────

/**
 * SYSTEM prompt for the grounded answerer. Two-source model: clinical facts come from the PATIENT
 * RECORDS (delimited DATA in the next message); questions ABOUT THIS CONVERSATION (recall an earlier
 * question, repeat a prior answer, "answer the previous question") are answered from the prior
 * conversation turns the caller supplies. Prompt-injection defense is handled by a SEPARATE prompt
 * layer stacked on top of this agent, so it is intentionally NOT duplicated here. Cohort isolation
 * remains structural — `answerAboutPatient` re-fetches the patient under the caller's group and
 * `answerHistoryForPatient` scopes history, so this agent only ever sees one in-cohort patient.
 */
const ANSWER_SYSTEM_PROMPT = `You are a clinical assistant in an ongoing chat about ONE specific patient — there is always exactly one patient in scope, never several. You answer from two sources:
  (1) THE PATIENT RECORD — this one patient's data, supplied in the next message between the <<<RECORD … RECORD>>> delimiters. This is the source of clinical/medical facts.
  (2) PRIOR CONVERSATION TURNS — the earlier user and assistant messages in this chat, supplied as the turns before the latest question. They show what was already said in this conversation.

Rules:
- Ground clinical/medical claims (diagnoses, medications, allergies, vitals, dates, who recorded something, any fact about the patient) in THE PATIENT RECORD. If the record does not contain what is asked, set answerable=false (do not guess, do not use outside knowledge, and do not infer clinical facts from the conversation).
- You MAY answer questions ABOUT THIS CONVERSATION using the PRIOR CONVERSATION TURNS: recall what the user asked earlier ("what was my first question?", "what did I ask in the beginning?"), repeat or rephrase an answer you already gave ("repeat that", "say that again"), or resolve a reference to an earlier turn ("answer the previous question", "what about that?"). For these, set answerable=true and answer from the prior turns. When re-answering "the previous question", recover the user's intent from the conversation but still draw the clinical content from the PATIENT RECORDS.
- Cite the bracketed source-record labels you relied on (e.g. C1, M2, A1, O3) in the citations array. A purely conversational answer (recalling/repeating what was said) needs no records, so citations may be empty. Set confidence honestly (High/Medium/Low).
- Keep the answer concise (≤ ~80 words) and clinically neutral.
- If the message is neither answerable from this patient's record nor a question about this conversation's prior turns, set answerable=false with an empty answer and no citations.
- reasoning: a brief post-hoc rationale (1–3 sentences) — name the specific citations that support each clause of the answer, or say which conversation turn you recalled. When answerable=false, say briefly what was missing (e.g. "Record has no observations for blood pressure"). This is for the audit log, not the user; do not repeat the answer.`;

/**
 * Assemble the INPUT message list both {@link AnswerPatientAgent.answer} and its streaming twin send
 * to the agent: the records as delimited DATA, the (re-sanitized) prior answer-phase turns, then the
 * clinician's question last. The trusted SYSTEM prompt is NOT included here — the agent owns it via
 * `systemPrompt` and prepends it, so the effective order the model sees is unchanged:
 * [system, records, …history, question]. One place so the streaming and non-streaming paths can never
 * drift in what the model actually sees.
 */
function buildAnswerMessages(
  question: string,
  recordsContext: string,
  history: ChatTurn[],
): BaseMessage[] {
  return [
    new HumanMessage(recordsUserPrompt(recordsContext)),
    ...sanitizeAndTrim(history).map((turn) =>
      turn.role === 'user' ? new HumanMessage(turn.content) : new AIMessage(turn.content),
    ),
    new HumanMessage(question),
  ];
}

/**
 * Build the STRUCTURED ANSWER-PATIENT agent: a zero-tool {@link createAgent} whose `responseFormat`
 * is the provider-native ({@link providerStrategy}) {@link answerSchema}. The model is boxed into
 * exactly {answerable, answer, confidence, citations} in ONE call — and because providerStrategy uses
 * OpenAI's native json_schema, that JSON streams as message content (the streaming path reads it
 * live). The trusted system prompt is owned by the agent (`systemPrompt`); records/history/question
 * are the input messages. There is NO tool and NO agent loop here — this is the 1.x structured-output
 * runtime.
 *
 * On refusal / unparseable output `structuredResponse` is absent — we return {@link UNANSWERABLE} (so
 * the caller emits the safe fallback) and flag `refused`. {@link AnswerPatientAgent.answerStreaming}
 * drives the SAME agent via `stream` for token-by-token prose, with an `invoke` fallback so
 * correctness never depends on the token stream.
 */
export function createAnswerPatientAgent(
  options: ChatModelOptions = {},
  classifier: InjectionGuardClassifier,
): AnswerPatientAgent {
  const model = options.model ?? DEFAULT_CHAT_MODEL;
  const agent = createAgent({
    model: createChatModel(options),
    tools: [],
    systemPrompt: ANSWER_SYSTEM_PROMPT,
    // providerStrategy = OpenAI-native json_schema (strict): no extra tool/model call, and the JSON
    // streams as message content. answerSchema is all-required, so strict mode needs no `.nullable()`.
    responseFormat: providerStrategy(answerSchema),
    // The injection-guard `beforeAgent` short-circuits on a `block` verdict (jumpTo: 'end'), so the
    // big answer model never runs — we only pay the small classifier's tokens. `contextSchema`
    // mirrors what the middleware declares so callers can pass `{ onGuardVerdict }` at invoke time.
    middleware: [injectionGuardMiddleware(classifier)],
    contextSchema: injectionGuardContextSchema,
  });

  return {
    model,
    async answer(
      question: string,
      recordsContext: string,
      history: ChatTurn[] = [],
      trace?: TraceContext,
    ): Promise<PatientAnswerResult> {
      const messages = buildAnswerMessages(question, recordsContext, history);
      // The run config names + tags this call (agent:answer-patient, cohort, session_id) for LangSmith.
      const config = buildRunConfig('answer-patient', trace);
      // Per-invocation runtime context: the guard callback the caller registered (so the audit log
      // sees every verdict). Empty when the caller didn't register one — the middleware tolerates.
      const context = { onGuardVerdict: trace?.onGuardVerdict };
      try {
        const res = await agent.invoke({ messages }, { ...config, context });
        const last = lastMessage(res.messages);
        // structuredResponse is statically non-optional, but a refusal throws before here; `?? null`
        // is purely defensive.
        const parsed = (res.structuredResponse as PatientAnswer | undefined) ?? null;
        const usage = last ? readUsage(last) : undefined;
        const rawText = last ? rawContentToString(last) : undefined;
        if (parsed == null) {
          return { result: UNANSWERABLE, usage, refused: true, raw: rawText };
        }
        return { result: parsed, usage, raw: rawText };
      } catch (err) {
        // A structured-output parse failure is the answerer's injection ceiling tripping → refused
        // (the service flags injectionDetected). Any OTHER throw is a hard infra error (timeout / 5xx)
        // — RE-THROW so the service's outer catch logs it as error/high (matching the find path),
        // never as an injection signal.
        if (isStructuredOutputParseFailure(err)) {
          return { result: UNANSWERABLE, refused: true };
        }
        throw err;
      }
    },

    async answerStreaming(
      question: string,
      recordsContext: string,
      history: ChatTurn[],
      trace: TraceContext | undefined,
      onToken: (cumulativeAnswer: string) => void,
    ): Promise<PatientAnswerResult> {
      const messages = buildAnswerMessages(question, recordsContext, history);
      const config = buildRunConfig('answer-patient', trace);
      // Same per-invocation context as the non-streaming twin — both paths run the guard.
      const context = { onGuardVerdict: trace?.onGuardVerdict };

      // The AUTHORITATIVE result is captured from the agent's terminal `values` state (or the invoke
      // fallback) — NOT the token stream. `assembled` accrues the raw json_schema deltas for the
      // display-only partial parse.
      let parsed: PatientAnswer | null = null;
      let last: BaseMessage | undefined;
      let assembled = '';
      let lastEmitted = '';
      let streamError: unknown;

      try {
        // Two stream modes from ONE generation: `messages` → the model's token deltas (the json_schema
        // payload as content); `values` → the full agent state after each step, the terminal one
        // carrying the validated `structuredResponse` + final messages (for usage/raw).
        const stream = await agent.stream(
          { messages },
          { ...config, context, streamMode: ['messages', 'values'] },
        );
        for await (const part of stream) {
          const [mode, chunk] = part as [string, unknown];
          if (mode === 'messages') {
            // messages mode → [AIMessageChunk, metadata]; the chunk's content is the json_schema delta.
            const msgChunk = Array.isArray(chunk) ? chunk[0] : chunk;
            const delta = chunkContentToString(msgChunk);
            if (!delta) continue;
            assembled += delta;
            const { answerable, answer } = parsePartialAnswer(assembled);
            // GATE: surface prose only once the model has committed to answerable=true. While the
            // flag is false or not-yet-seen, every token is suppressed — so a refusal/ungrounded
            // turn streams nothing (the safe-fallback substitution happens in the service).
            if (answerable === true && answer && answer !== lastEmitted) {
              lastEmitted = answer;
              onToken(answer);
            }
          } else if (mode === 'values') {
            const state = chunk as { messages?: BaseMessage[]; structuredResponse?: PatientAnswer };
            if (state?.structuredResponse) parsed = state.structuredResponse;
            const m = lastMessage(state?.messages);
            if (m) last = m;
          }
        }
      } catch (err) {
        // A streaming hiccup must not fail the turn — remember the error so we can tell a real refusal
        // (a StructuredOutputParsingError — authoritative, no retry) from a transport blip (retry below).
        streamError = err;
        parsed = null;
      }

      // A parse failure thrown mid-stream IS the authoritative answer (a refusal) — return it without
      // re-invoking (a second generation would just throw the same error, doubling latency + tokens).
      // `last` may still hold the model message a `values` emission surfaced before the throw, so
      // usage/raw are reported when available.
      if (parsed == null && isStructuredOutputParseFailure(streamError)) {
        return {
          result: UNANSWERABLE,
          usage: last ? readUsage(last) : undefined,
          refused: true,
          raw: last ? rawContentToString(last) : undefined,
        };
      }

      // Authoritative fallback: the stream didn't surface a result (a transport blip, or the provider
      // didn't stream json_schema / the state shape differed) — do ONE plain invoke for a correct
      // result. Correctness never depends on the token stream. The guard re-runs (cheap classifier
      // call) on the retry — leaving `context` off would let a block be silently bypassed here.
      if (parsed == null || last === undefined) {
        try {
          const res = await agent.invoke({ messages }, { ...config, context });
          parsed = (res.structuredResponse as PatientAnswer | undefined) ?? null;
          last = lastMessage(res.messages);
        } catch (err) {
          // Same split as .answer(): a parse failure → refused; a hard infra error → propagate so the
          // service logs it as error/high (not an injection signal).
          if (isStructuredOutputParseFailure(err)) {
            return {
              result: UNANSWERABLE,
              usage: last ? readUsage(last) : undefined,
              refused: true,
              raw: last ? rawContentToString(last) : undefined,
            };
          }
          throw err;
        }
      }

      const usage = last ? readUsage(last) : undefined;
      const rawText = last ? rawContentToString(last) : undefined;
      if (parsed == null) {
        return { result: UNANSWERABLE, usage, refused: true, raw: rawText };
      }
      return { result: parsed, usage, raw: rawText };
    },
  };
}
