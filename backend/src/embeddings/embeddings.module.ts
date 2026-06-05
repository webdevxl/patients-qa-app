import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';

/** Provides the OpenAI embeddings client to any feature module that imports this. */
@Module({
  providers: [EmbeddingsService],
  exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
