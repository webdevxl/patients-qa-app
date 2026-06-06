import { OpenAIEmbeddings } from '@langchain/openai';

/**
 * Single source of truth for the embedding model + dimensionality. Kept Nest-free so the
 * standalone Prisma backfill scripts (prisma/embed-icd-*.ts) can reuse it without pulling in
 * the Nest runtime.
 *
 * IMPORTANT: the model + dimensions must match the `vector(1536)` column in schema.prisma and
 * any committed embedding artifact. Changing the model means re-embedding everything — vectors
 * from a different model are not comparable.
 */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

// Client-side resilience: a stalled embeddings call fails fast instead of inheriting the SDK's
// ~10-minute default, and concurrency is bounded so a burst can't fan out unbounded to OpenAI.
const EMBEDDING_TIMEOUT_MS = 15_000;
const EMBEDDING_MAX_RETRIES = 2;
const EMBEDDING_MAX_CONCURRENCY = 8;

/**
 * Build a configured OpenAI embeddings client. Reads OPENAI_API_KEY from the environment. `model` is
 * a parameter (default {@link EMBEDDING_MODEL}) so the standalone Prisma backfill scripts can reuse
 * this — but it MUST stay consistent with the committed `vector(1536)` artifacts: vectors from a
 * different model are not comparable, so don't point this at an incompatible model.
 */
export function createEmbeddingsClient(
  model: string = EMBEDDING_MODEL,
): OpenAIEmbeddings {
  return new OpenAIEmbeddings({
    model,
    timeout: EMBEDDING_TIMEOUT_MS,
    maxRetries: EMBEDDING_MAX_RETRIES,
    maxConcurrency: EMBEDDING_MAX_CONCURRENCY,
  });
}

/**
 * Format a vector as a pgvector literal, e.g. `[0.1,0.2,0.3]`. Bind this as a text parameter
 * and cast it in SQL (`$1::vector`) — that's how we write/query the `Unsupported` column
 * without needing an extra driver dependency.
 */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
