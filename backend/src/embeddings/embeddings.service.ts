import { Injectable } from '@nestjs/common';
import type { OpenAIEmbeddings } from '@langchain/openai';
import { createEmbeddingsClient } from './embeddings.factory';

/**
 * Thin Nest wrapper around the OpenAI embeddings client. Injected into QaService so the
 * condition-search tool can embed the user's free-text query at request time. The client is
 * constructed once and reused across requests (stateless, connection-pooled by the SDK).
 */
@Injectable()
export class EmbeddingsService {
  private readonly client: OpenAIEmbeddings = createEmbeddingsClient();

  /** Embed a single query string → its vector. */
  embedQuery(text: string): Promise<number[]> {
    return this.client.embedQuery(text);
  }

  /** Embed many documents in one batched call → one vector per input. */
  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.client.embedDocuments(texts);
  }
}
