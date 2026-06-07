import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import { createAgent, toolStrategy, tool } from 'langchain';
import type { ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import {
  createChatModel,
  sanitizeAndTrim,
  sumUsage,
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
  lastMessage,
  isStructuredOutputParseFailure,
} from '../../core/answer.shared';
import {
  injectionGuardMiddleware,
  injectionGuardContextSchema,
} from '../../../shared/security/injection-guard.middleware';
import type { InjectionGuardClassifier } from '../../../shared/security/injection-guard.classifier';

/**
 * The TOOL-CALLING A/B arm of the ANSWER stage. A {@link createAgent} with a `get_patient_record`
 * tool and a `toolStrategy` answer schema: the model first CALLS the tool (which returns this one
 * patient's already-cohort-verified record from the runtime context), then emits the structured
 * answer as its output tool call. Implements the shared {@link AnswerPatientAgent} interface and
 * emits the same {@link answerSchema} object as the structured arm
 * (`variants/structured/answer-patient.agent.ts`).
 *
 * Same injection posture and structural cohort isolation as the control arm: the SAME
 * injection-guard middleware short-circuits a blocked question, and `QaService` re-fetched this one
 * patient under the caller's group before we got here.
 */

/**
 * Runtime context for the tool-calling answerer: the injection-guard callback (as in the structured
 * arm) PLUS the already-cohort-verified serialized record, handed to the `get_patient_record` tool.
 * Passing the record via context (not closure) lets the agent be built ONCE while staying race-safe —
 * context is per-invocation. Cohort isolation is unchanged: `QaService` re-fetched this one patient
 * under the caller's group before we got here, and the tool returns ONLY that record.
 */
const answerToolContextSchema = injectionGuardContextSchema.extend({
  recordsContext: z.string().optional(),
});

/**
 * SYSTEM prompt for the tool-calling answer arm: identical two-source rules to the structured arm's
 * ANSWER_SYSTEM_PROMPT, except the record arrives via a TOOL the model must call first rather than
 * inline. Same injection posture (a separate guard layer handles injection; cohort isolation is
 * structural).
 */
const ANSWER_TOOL_SYSTEM_PROMPT = `You are a clinical assistant in an ongoing chat about ONE specific patient — always exactly one patient in scope. To answer clinical/medical questions you MUST first call the \`get_patient_record\` tool (no arguments) to load THIS patient's record, then ground your answer in it. You answer from two sources:
  (1) THE PATIENT RECORD — returned by \`get_patient_record\`, delimited by <<<RECORD … RECORD>>>. The source of all clinical/medical facts.
  (2) PRIOR CONVERSATION TURNS — the earlier user/assistant messages in this chat.

Rules:
- Ground clinical/medical claims (diagnoses, medications, allergies, vitals, dates, who recorded something) in THE PATIENT RECORD. Call \`get_patient_record\` before making any such claim. If the record does not contain what is asked, set answerable=false (do not guess, do not use outside knowledge).
- You MAY answer questions ABOUT THIS CONVERSATION (recall an earlier question, repeat a prior answer, resolve "the previous question") from the PRIOR CONVERSATION TURNS without the record; set answerable=true and answer from those turns.
- Cite the bracketed source-record labels you relied on (e.g. C1, M2, A1, O3). A purely conversational answer needs no records, so citations may be empty. Set confidence honestly (High/Medium/Low).
- Keep the answer concise (≤ ~80 words) and clinically neutral.
- If the message is neither answerable from this patient's record nor a question about this conversation, set answerable=false with an empty answer and no citations.
- reasoning: a brief post-hoc rationale (1–3 sentences) naming the citations that support each clause, or which turn you recalled. When answerable=false, say briefly what was missing. Audit-log only; never repeat the answer.`;

/** The input message list for the tool-calling arm — like the structured arm's buildAnswerMessages but
 *  WITHOUT the inline record (the model pulls it via `get_patient_record`): just prior turns, then the question. */
function buildAnswerMessagesNoRecords(question: string, history: ChatTurn[]): BaseMessage[] {
  return [
    ...sanitizeAndTrim(history).map((turn) =>
      turn.role === 'user' ? new HumanMessage(turn.content) : new AIMessage(turn.content),
    ),
    new HumanMessage(question),
  ];
}

/**
 * The TOOL-CALLING answer arm: a {@link createAgent} with a `get_patient_record` tool and a
 * `toolStrategy` answer schema. The model first CALLS the tool (which returns this one patient's
 * already-cohort-verified record from the runtime context), then emits the structured answer as its
 * output tool call. `toolStrategy` (not `providerStrategy`) is deliberate here — the answer is itself
 * a tool call, so it composes cleanly with the record tool in the same loop. The SAME
 * injection-guard middleware short-circuits a blocked question before any of this runs.
 *
 * Streaming on this arm emits the final answer in ONE chunk (the tool round-trip means there's no
 * meaningful token-by-token prefix to surface, and toolStrategy's deltas are tool-call args, not
 * answer prose) — so `answerStreaming` runs the same path and calls `onToken` once with the result.
 */
export function createAnswerPatientAgentToolCalling(
  options: ChatModelOptions = {},
  classifier: InjectionGuardClassifier,
): AnswerPatientAgent {
  const model = options.model ?? DEFAULT_CHAT_MODEL;

  const getPatientRecordTool = tool(
    (_input: Record<string, never>, runtime: ToolRuntime<unknown, typeof answerToolContextSchema>) => {
      const record = runtime?.context?.recordsContext;
      // The record is always supplied by QaService on the answer path; the guard is defensive.
      return record && record.trim().length > 0
        ? recordsUserPrompt(record)
        : 'No record is available for this patient.';
    },
    {
      name: 'get_patient_record',
      description:
        "Load THIS patient's full record (demographics, conditions, medications, allergies, " +
        'observations) with bracketed citation labels. Call once, with no arguments, before ' +
        'answering any clinical question.',
      schema: z.object({}),
    },
  );

  const agent = createAgent({
    model: createChatModel(options),
    tools: [getPatientRecordTool],
    systemPrompt: ANSWER_TOOL_SYSTEM_PROMPT,
    responseFormat: toolStrategy(answerSchema),
    middleware: [injectionGuardMiddleware(classifier)],
    contextSchema: answerToolContextSchema,
  });

  const run = async (
    question: string,
    recordsContext: string,
    history: ChatTurn[],
    trace?: TraceContext,
  ): Promise<PatientAnswerResult> => {
    const messages = buildAnswerMessagesNoRecords(question, history);
    const config = buildRunConfig('answer-patient', trace);
    const context = { onGuardVerdict: trace?.onGuardVerdict, recordsContext };
    try {
      const res = await agent.invoke({ messages }, { ...config, context });
      const usage = sumUsage(res.messages);
      const last = lastMessage(res.messages);
      const parsed = (res.structuredResponse as PatientAnswer | undefined) ?? null;
      const rawText = last ? rawContentToString(last) : undefined;
      if (parsed == null) {
        return { result: UNANSWERABLE, usage, refused: true, raw: rawText };
      }
      return { result: parsed, usage, raw: rawText };
    } catch (err) {
      // Same split as the structured arm: a structured-output parse failure → refused; any other
      // throw is a hard infra error that must propagate so the service logs it as error/high.
      if (isStructuredOutputParseFailure(err)) {
        return { result: UNANSWERABLE, refused: true };
      }
      throw err;
    }
  };

  return {
    model,
    answer: (question, recordsContext, history = [], trace) =>
      run(question, recordsContext, history, trace),
    async answerStreaming(question, recordsContext, history, trace, onToken) {
      const out = await run(question, recordsContext, history, trace);
      // One-shot "stream": surface the final grounded answer once (only when answerable), so the SSE
      // endpoint still emits a token event and the client renders it the same way.
      if (out.result.answerable && out.result.answer) onToken(out.result.answer);
      return out;
    },
  };
}
