/**
 * Standalone graph entrypoint for LangGraph Studio (`langgraph dev`).
 *
 * The production HTTP path no longer uses an agent — `QaService` now runs a single
 * structured-output EXTRACTOR (see patient-qa.agent.ts) and routes in code. Studio still needs a
 * compiled LangGraph graph to render, so here we assemble the *tool-calling* variant of the same
 * retrieval flow from the retained tool factories. It shares the exact retrieval/embedding logic
 * (find_patient / find_patients_by_condition) the HTTP path calls directly, so Studio remains a
 * faithful place to experiment with the tools; only the routing mechanism differs.
 *
 * The local LangGraph server loads this module OUTSIDE Nest's DI container, so we construct a
 * plain `PrismaClient` (PrismaService is a thin DI/lifecycle wrapper around it) and a bare
 * `EmbeddingsService` (no DI deps). The connection is lazy, so this module is cheap to import.
 *
 * Tracing → LangSmith: `langgraph.json` loads `backend/.env`, so when the LANGSMITH_* vars are
 * set both the LangGraph server and the agent stream every run to LangSmith with no extra wiring.
 */
import { createAgent } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { createFindPatientsTool } from './tools/find-patients.tool';
import { createTracingMiddleware } from './middleware/tracing.middleware';
import { createTerminateAfterToolMiddleware } from './middleware/terminate-after-tool.middleware';

// PrismaService adds only Nest lifecycle hooks on top of PrismaClient; the tool uses plain client
// query methods, so a bare client is a safe structural substitute outside Nest.
const prisma = new PrismaClient() as unknown as PrismaService;
const embeddings = new EmbeddingsService();

const STUDIO_SYSTEM_PROMPT = `You are the retrieval step of a clinical assistant — Studio/tool-calling view. Call the single find_patients tool and set whichever argument(s) apply:
• patientId / name — for a SPECIFIC patient by UUID or name.
• conditionQuery — for "which patients have <condition>".
• allergyQuery — for "who is allergic to <substance>" (an allergy is NOT a diagnosis).
Identity (id/name) takes priority. If nothing applies, do not call the tool.`;

const model = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 });

// `createAgent` returns a compiled LangGraph graph — Studio renders and runs it directly.
export const graph = createAgent({
  model,
  tools: [createFindPatientsTool(prisma, embeddings)],
  systemPrompt: STUDIO_SYSTEM_PROMPT,
  middleware: [createTerminateAfterToolMiddleware(), createTracingMiddleware()],
});
