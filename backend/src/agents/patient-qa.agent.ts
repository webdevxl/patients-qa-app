import { createAgent } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import type { PrismaService } from '../prisma/prisma.service';
import { createFindPatientTool } from './tools/find-patient.tool';
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
 * The model's ONLY job is patient resolution — extract an ID/name and call `find_patient`. It
 * never answers the clinical question: the tool is the terminal step (see
 * `createTerminateAfterToolMiddleware`), so its retrieved records are returned to the client
 * directly and are never sent back to the model to summarize.
 */
const SYSTEM_PROMPT = `You are the patient-resolution step of a clinical assistant. You do NOT answer the user's question — another layer returns the records. Your sole task is to identify which patient is being asked about and call the find_patient tool.

From the user's question, extract:
- the patient ID (a UUID), if present, and/or
- the patient name (full, or just a first or last name), if present.
Then call the find_patient tool with whichever you found (ID is preferred when both are given). Pass only what the user actually supplied — do not invent an ID or a name. Call find_patient at most once.

If the question references no identifiable patient at all, do not call the tool; reply with exactly this and nothing else: "${SAFE_FALLBACK}"`;

/**
 * Build the patient Q&A agent: a prebuilt LangChain 1.x agent (`createAgent`) wired to
 * ChatOpenAI and the find-patient tool. Pure LangChain — no Nest decorators. Prisma is
 * passed in so the tool can query the database.
 */
export function createPatientQaAgent(prisma: PrismaService) {
  const model = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 }); // reads OPENAI_API_KEY
  const tools = [createFindPatientTool(prisma)];

  // Middleware order matters: terminate-after-tool runs its `beforeModel` first so it can
  // short-circuit the post-tool model call (jumpTo 'end') before tracing logs a phantom
  // "calling model". Tracing then taps every remaining lifecycle hook for observability.
  const middleware = [
    createTerminateAfterToolMiddleware(),
    createTracingMiddleware(),
  ];

  return createAgent({ model, tools, systemPrompt: SYSTEM_PROMPT, middleware });
}
