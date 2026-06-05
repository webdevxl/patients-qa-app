/**
 * Standalone graph entrypoint for LangGraph Studio (`langgraph dev`).
 *
 * The local LangGraph server loads this module OUTSIDE Nest's DI container, so we can't get a
 * `PrismaService` injected here. Instead we construct a plain `PrismaClient` (PrismaService is
 * only a thin DI/lifecycle wrapper around it — see ../prisma/prisma.service.ts) and hand it to
 * the *same* agent factory the HTTP layer uses, so Studio drives the real agent + tracing
 * middleware, not a stand-in. The connection is lazy (Prisma connects on first query), so this
 * module is cheap to import and the dev server boots even before Postgres/the LLM are reached.
 *
 * Tracing → LangSmith: `langgraph.json` loads `backend/.env`, so when the LANGSMITH_* vars are
 * set both the LangGraph server and the LangChain agent stream every run to LangSmith with no
 * extra wiring.
 */
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { createPatientQaAgent } from './patient-qa.agent';

// PrismaService adds only Nest lifecycle hooks on top of PrismaClient; the agent's tool uses
// plain client query methods, so a bare client is a safe structural substitute outside Nest.
const prisma = new PrismaClient() as unknown as PrismaService;

// EmbeddingsService has no DI dependencies (it builds its own OpenAI client), so a plain
// `new` is fine outside Nest — same instance the HTTP layer's condition-search tool uses.
const embeddings = new EmbeddingsService();

// `createAgent` returns a compiled LangGraph graph — Studio renders and runs it directly.
export const graph = createPatientQaAgent(prisma, embeddings);
