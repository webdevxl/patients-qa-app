import { createAgent } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import type { PrismaService } from '../prisma/prisma.service';
import type { EmbeddingsService } from '../embeddings/embeddings.service';
import { createFindPatientTool } from './tools/find-patient.tool';
import { createFindPatientsByConditionTool } from './tools/find-patients-by-condition.tool';
import { createTracingMiddleware } from './middleware/tracing.middleware';
import { createTerminateAfterToolMiddleware } from './middleware/terminate-after-tool.middleware';

/**
 * Safe fallback string (used verbatim per the spec) for when no patient can be resolved.
 * The model only emits this when it decides NOT to call the tool; once `find_patient` runs,
 * its result goes straight to the client and `QaService` derives the fallback for empty matches.
 */
export const SAFE_FALLBACK =
  'I cannot find a matching patient in your cohort, or I cannot answer this question based on the available records.';

/**
 * The model's ONLY job is RETRIEVAL ROUTING — pick the right tool and extract its argument(s).
 * It never answers the clinical question: whichever tool runs is the terminal step (see
 * `createTerminateAfterToolMiddleware`), so the retrieved records/matches are returned to the
 * client directly and are never sent back to the model to summarize.
 *
 * Two tools, two intents:
 *   • find_patient                — the question is about ONE specific patient (name or UUID).
 *   • find_patients_by_condition  — the question asks WHICH patients have a condition/symptom.
 */
const SYSTEM_PROMPT = `You are the retrieval-routing step of a clinical assistant. You do NOT answer the user's question — another layer returns the records. Your sole task is to choose the right tool and pass it the correct argument(s).

Pick ONE tool (call at most one):

1. find_patient — use when the question is about a SPECIFIC patient identified by name or UUID
   (e.g. "What medications is Adolfo Ricker on?", "Tell me about patient 9ec974ce-..."). Extract:
   - the patient ID (a UUID), if present, and/or
   - the patient name (full, or just a first or last name), if present.
   Pass whichever the user actually supplied (ID preferred when both are given). Never invent one.

2. find_patients_by_condition — use when the question asks WHICH or HOW MANY patients have a
   medical condition, disease, or symptom (e.g. "Which patients have diabetes?", "Who has
   dementia?", "List patients with chronic pain"). Pass the clinical concept as conditionQuery —
   the condition only, never a patient name.

If the question references neither an identifiable patient nor a searchable condition, do not call any tool; reply with exactly this and nothing else: "${SAFE_FALLBACK}"`;

/**
 * Build the patient Q&A agent: a prebuilt LangChain 1.x agent (`createAgent`) wired to
 * ChatOpenAI and the retrieval tools. Pure LangChain — no Nest decorators. Prisma and the
 * embeddings client are passed in so the tools can query the database / embed the condition
 * query.
 */
export function createPatientQaAgent(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
) {
  const model = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 }); // reads OPENAI_API_KEY
  const tools = [
    createFindPatientTool(prisma),
    createFindPatientsByConditionTool(prisma, embeddings),
  ];

  // Middleware order matters: terminate-after-tool runs its `beforeModel` first so it can
  // short-circuit the post-tool model call (jumpTo 'end') before tracing logs a phantom
  // "calling model". Tracing then taps every remaining lifecycle hook for observability.
  const middleware = [
    createTerminateAfterToolMiddleware(),
    createTracingMiddleware(),
  ];

  return createAgent({ model, tools, systemPrompt: SYSTEM_PROMPT, middleware });
}
