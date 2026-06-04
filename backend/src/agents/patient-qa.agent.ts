import { createAgent } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { PrismaService } from '../prisma/prisma.service';
import { createFindPatientTool } from './tools/find-patient.tool';

/**
 * Phase 1 system prompt: extract a patient ID and/or name from the question, call the
 * find_patient tool, then answer from the returned details — or emit the safe fallback
 * when nothing matches. No cohort scoping or injection hardening yet (later phases).
 */
const SAFE_FALLBACK =
  'I cannot find a matching patient in your cohort, or I cannot answer this question based on the available records.';

const SYSTEM_PROMPT = `You are a clinical assistant that answers questions about a patient, grounded strictly in their records.

To find the patient, extract from the user's question:
- the patient ID (a UUID), if present, and/or
- the patient name (full, or just a first or last name), if present.
Then call the find_patient tool with whichever you found (ID is preferred when both are given). Pass only what the user actually supplied — do not invent an ID or a name.

Using the tool result:
- If matchCount is 0, reply with exactly this and nothing else: "${SAFE_FALLBACK}"
- If exactly one patient matches, answer the question concisely using only that patient's returned details (demographics, conditions, medications, allergies, observations).
- If more than one patient matches, briefly list the matches (name + ID) and ask the user to clarify which one they mean.

Never answer about a patient from outside the tool results, and never fabricate clinical details.`;

/**
 * Build the patient Q&A agent: a prebuilt LangChain 1.x agent (`createAgent`) wired to
 * ChatOpenAI and the find-patient tool. Pure LangChain — no Nest decorators. Prisma is
 * passed in so the tool can query the database.
 */
export function createPatientQaAgent(prisma: PrismaService) {
  const model = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 }); // reads OPENAI_API_KEY
  const tools = [createFindPatientTool(prisma)];

  return createAgent({ model, tools, systemPrompt: SYSTEM_PROMPT });
}
