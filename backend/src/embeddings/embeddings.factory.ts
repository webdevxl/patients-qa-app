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

/** Build a configured OpenAI embeddings client. Reads OPENAI_API_KEY from the environment. */
export function createEmbeddingsClient(): OpenAIEmbeddings {
  return new OpenAIEmbeddings({ model: EMBEDDING_MODEL });
}

/**
 * Format a vector as a pgvector literal, e.g. `[0.1,0.2,0.3]`. Bind this as a text parameter
 * and cast it in SQL (`$1::vector`) — that's how we write/query the `Unsupported` column
 * without needing an extra driver dependency.
 */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
