import { Module } from '@nestjs/common';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';
import { EmbeddingsModule } from '../embeddings/embeddings.module';

// PrismaService is available via the @Global() PrismaModule — no import needed here.
// EmbeddingsModule provides the OpenAI embeddings client for condition search.
@Module({
  imports: [EmbeddingsModule],
  controllers: [QaController],
  providers: [QaService],
})
export class QaModule {}
