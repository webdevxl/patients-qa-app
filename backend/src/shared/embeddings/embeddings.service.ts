import { Injectable } from '@nestjs/common';
import type { OpenAIEmbeddings } from '@langchain/openai';
import { createEmbeddingsClient, EMBEDDING_MODEL } from './embeddings.factory';

/** Max distinct query strings to keep embedded in memory (LRU). */
const QUERY_CACHE_LIMIT = 2000;

/**
 * Thin Nest wrapper around the OpenAI embeddings client. Injected into QaService so the
 * attribute-search retrieval can embed the user's free-text query at request time. The client is
 * constructed once and reused across requests (stateless, connection-pooled by the SDK).
 *
 * Query embeddings are cached (LRU, keyed by model + normalized text): clinical searches repeat
 * heavily ("diabetes", "penicillin"), embeddings are deterministic for a fixed model, and this
 * removes a per-request network round-trip (and its cost/availability dependency) from the hot path.
 * The vector encodes only the clinical concept — never patient/cohort data — so caching is
 * cohort-neutral and cannot leak across groups (cohort scoping happens later, in SQL).
 */
@Injectable()
export class EmbeddingsService {
  private readonly client: OpenAIEmbeddings = createEmbeddingsClient();
  private readonly queryCache = new Map<string, number[]>();

  /** Embed a single query string → its vector (cached). */
  async embedQuery(text: string): Promise<number[]> {
    const key = `${EMBEDDING_MODEL}:${text.trim().toLowerCase()}`;
    const cached = this.queryCache.get(key);
    if (cached) {
      // Touch for LRU recency: re-insert moves the key to the most-recent position.
      this.queryCache.delete(key);
      this.queryCache.set(key, cached);
      return cached;
    }
    const vector = await this.client.embedQuery(text);
    this.queryCache.set(key, vector);
    if (this.queryCache.size > QUERY_CACHE_LIMIT) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    return vector;
  }

  /** Embed many documents in one batched call → one vector per input. */
  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.client.embedDocuments(texts);
  }
}
