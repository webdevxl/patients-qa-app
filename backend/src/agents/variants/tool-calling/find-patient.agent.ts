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
} from '../../core/agent-base';
import { createFindPatientsTool, type FindPatientsResult } from '../../core/tools/find-patients.tool';
import { createTerminateAfterToolMiddleware } from '../../core/middleware/terminate-after-tool.middleware';
import { createTracingMiddleware } from '../../core/middleware/tracing.middleware';
import type { PrismaService } from '../../../shared/prisma/prisma.service';
import type { EmbeddingsService } from '../../../shared/embeddings/embeddings.service';
import type { CohortGroup } from '../../../shared/security/cohort.types';
import {
  EMPTY_RETRIEVAL,
  type FindResolution,
  type FindPatientResolver,
} from '../../core/find.contract';

/**
 * The TOOL-CALLING A/B arm of the FIND stage. Instead of extracting a fixed schema, the LLM itself
 * decides which lookup to run by CALLING the single `find_patients` tool (the classic agent loop,
 * exactly like studio.graph.ts), and we read the tool's result back. It implements the shared
 * {@link FindPatientResolver} contract and returns the SAME {@link FindResolution} the structured arm
 * does, so `QaService` runs one code path.
 *
 * Cohort isolation is identical to the control arm: the tool is BOUND to `group` at construction — the
 * model can pass search args but can never reach another cohort.
 */

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
