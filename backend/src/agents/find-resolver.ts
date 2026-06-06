import { createAgent } from 'langchain';
import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import {
  createChatModel,
  sanitizeAndTrim,
  sumUsage,
  rawContentToString,
  buildRunConfig,
  DEFAULT_CHAT_MODEL,
  type ChatModelOptions,
  type ChatTurn,
  type TokenUsage,
  type TraceContext,
} from './agent-base';
import type { FindPatientAgent } from './find-patient.agent';
import {
  findPatients,
  createFindPatientsTool,
  type FindPatientsResult,
} from './tools/find-patients.tool';
import { createTerminateAfterToolMiddleware } from './middleware/terminate-after-tool.middleware';
import { createTracingMiddleware } from './middleware/tracing.middleware';
import type { PrismaService } from '../shared/prisma/prisma.service';
import type { EmbeddingsService } from '../shared/embeddings/embeddings.service';
import type { CohortGroup } from '../shared/security/cohort.types';
import type { AgentVariant } from '../shared/security/variant.types';

/**
 * The FIND stage behind ONE seam, so `QaService` runs a single code path for both A/B arms. A
 * resolver takes the clinician's question + history and returns the SAME {@link FindPatientsResult}
 * the downstream shaping already expects — only HOW it gets there differs:
 *
 *   • 'structured'   — the control: a `withStructuredOutput` extraction (find-patient.agent.ts) then
 *                      a deterministic `findPatients(...)` call routed in code.
 *   • 'tool_calling' — the LLM itself decides which lookup to run by CALLING the `find_patients` tool
 *                      (the classic agent loop, exactly like studio.graph.ts), and we read the tool's
 *                      result back.
 *
 * Cohort isolation is identical on both arms: `findPatients(..., group)` scopes every SQL read, and
 * the tool-calling tool is BOUND to `group` at construction — the model can pass search args but can
 * never reach another cohort.
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
const EMPTY_RETRIEVAL: FindPatientsResult = { query: {}, matchCount: 0 };

// ───────────────────────── structured (control) resolver ─────────────────────────

/**
 * The control arm: reuse the existing structured-output extractor, then route the retrieval in code —
 * byte-identical to what `QaService` did inline before the A/B seam existed.
 */
export function createStructuredFindResolver(
  findAgent: FindPatientAgent,
  prisma: PrismaService,
  embeddings: EmbeddingsService,
): FindPatientResolver {
  return {
    model: findAgent.model,
    async resolve(question, history, group, trace): Promise<FindResolution> {
      const extraction = await findAgent.extract(question, history, trace);
      const retrieval = await findPatients(prisma, embeddings, extraction.extraction, group);
      return {
        retrieval,
        usage: extraction.usage,
        raw: extraction.raw,
        refused: extraction.refused,
        reasoning: extraction.extraction.reasoning,
      };
    },
  };
}

// ───────────────────────── tool-calling resolver ─────────────────────────

/**
 * SYSTEM prompt for the tool-calling FIND arm — the agent's only job is to call `find_patients` with
 * the right argument(s); the tool itself returns the records. Mirrors the structured extractor's
 * routing rules (identity wins; allergy ≠ diagnosis; combine across-patient filters) so the two arms
 * are comparing mechanism, not instructions. If nothing is searchable it must NOT call the tool —
 * which we treat as a no-match (fail closed).
 */
const FIND_TOOL_SYSTEM_PROMPT = `You are the retrieval step of a clinical assistant. Resolve the clinician's latest message to patient records by calling the single \`find_patients\` tool — set whichever argument(s) apply, then stop:
- patientId / name — a SPECIFIC patient by UUID or name. Resolve pronouns/references ("his meds", "that patient") to the patient named in earlier turns. Identity WINS: if the message names a patient AND mentions a condition/allergy, set name only.
- conditionQuery — a disease/diagnosis/symptom to search ACROSS patients ("who has diabetes?"). The clinical concept only.
- allergyQuery — a substance from an "allergic to X" search ACROSS patients. An allergy is NOT a diagnosis — never route it to conditionQuery. Combine with conditionQuery when both are asked.
- observationFilter — a numeric comparison over a vital/measurement ("weight over 200 lbs"). Combine with the others to intersect.
- medicationFilter — which patients TAKE a drug, optionally narrowed by dose/form/route. Combine to intersect.
Pass the clinical concept / substance ONLY in the query fields — never a name or ID there. Call the tool exactly once. If the message identifies no patient and asks for no searchable condition/allergy/measurement/medication, do NOT call the tool.`;

/** Message type tag, tolerant of both the 1.x `getType()` and legacy `_getType()` shapes. */
function messageType(msg: BaseMessage | undefined): string {
  if (!msg) return '';
  const m = msg as { getType?: () => string; _getType?: () => string };
  return typeof m.getType === 'function' ? m.getType() : (m._getType?.() ?? '');
}

/** Tool output is a JSON string in the `ToolMessage` content — recover the structured result. */
function parseToolResult(content: unknown): FindPatientsResult {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  try {
    const parsed = JSON.parse(text) as Partial<FindPatientsResult>;
    // Defensive: a malformed payload is treated as a no-match (fail closed), never a throw.
    if (parsed && typeof parsed.matchCount === 'number') {
      return { query: parsed.query ?? {}, ...parsed } as FindPatientsResult;
    }
  } catch {
    /* fall through to empty */
  }
  return EMPTY_RETRIEVAL;
}

/**
 * The tool-calling arm: a `createAgent` whose single `find_patients` tool drives retrieval. Built and
 * cached PER COHORT (the tool binds the group at construction), so each arm has at most two compiled
 * graphs. `terminate-after-tool` ends the loop the moment the tool returns (no second model pass that
 * could paraphrase/leak), leaving the `ToolMessage` as the last message — which we parse back into the
 * structured result. If the model declines to call the tool, there's no `ToolMessage` → no-match.
 */
export function createToolCallingFindResolver(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
  options: ChatModelOptions = {},
): FindPatientResolver {
  const model = options.model ?? DEFAULT_CHAT_MODEL;
  const byGroup = new Map<CohortGroup, ReturnType<typeof createAgent>>();

  const agentFor = (group: CohortGroup): ReturnType<typeof createAgent> => {
    let agent = byGroup.get(group);
    if (!agent) {
      agent = createAgent({
        model: createChatModel(options),
        tools: [createFindPatientsTool(prisma, embeddings, group)],
        systemPrompt: FIND_TOOL_SYSTEM_PROMPT,
        // terminate-after-tool BEFORE tracing so it short-circuits the phantom 2nd model call first.
        middleware: [createTerminateAfterToolMiddleware(), createTracingMiddleware()],
      });
      byGroup.set(group, agent);
    }
    return agent;
  };

  return {
    model,
    async resolve(question, history, group, trace): Promise<FindResolution> {
      const messages: BaseMessage[] = [
        ...sanitizeAndTrim(history).map((turn) =>
          turn.role === 'user' ? new HumanMessage(turn.content) : new AIMessage(turn.content),
        ),
        new HumanMessage(question),
      ];
      const res = (await agentFor(group).invoke(
        { messages },
        buildRunConfig('find-patient', trace),
      )) as { messages?: BaseMessage[] };

      const msgs = res.messages ?? [];
      // Walk from the end: the ToolMessage carries the retrieval; the AI message carries the
      // tool-call args (our best-effort raw output). Usage is summed across the loop's model calls.
      const toolMsg = [...msgs].reverse().find((m) => messageType(m) === 'tool');
      const aiMsg = [...msgs].reverse().find((m) => messageType(m) === 'ai');

      return {
        retrieval: toolMsg ? parseToolResult(toolMsg.content) : EMPTY_RETRIEVAL,
        usage: sumUsage(msgs),
        raw: aiMsg ? rawContentToString(aiMsg) : undefined,
        reasoning: null,
      };
    },
  };
}
