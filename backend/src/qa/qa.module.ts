import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import {
  createPatientQaExtractor,
  PATIENT_QA_EXTRACTOR,
} from '../agents/patient-qa.agent';
import {
  createPatientAnswerer,
  PATIENT_ANSWERER,
} from '../agents/patient-answer.agent';

// PrismaService is available via the @Global() PrismaModule — no import needed here.
// EmbeddingsModule provides the OpenAI embeddings client for attribute search.
@Module({
  imports: [EmbeddingsModule],
  controllers: [QaController],
  providers: [
    QaService,
    // The LLM extractor is DI-managed (mockable in tests, config-driven) rather than a field
    // initializer. Model/temperature come from env (OPENAI_CHAT_MODEL / OPENAI_CHAT_TEMPERATURE)
    // with the factory's defaults as fallback; ConfigService is global.
    {
      provide: PATIENT_QA_EXTRACTOR,
      useFactory: (config: ConfigService) => {
        const temperature = config.get<string>('OPENAI_CHAT_TEMPERATURE');
        return createPatientQaExtractor({
          model: config.get<string>('OPENAI_CHAT_MODEL') ?? undefined,
          temperature: temperature !== undefined ? Number(temperature) : undefined,
        });
      },
      inject: [ConfigService],
    },
    // The grounded ANSWERER for the patient-scoped path — same config plumbing as the extractor.
    {
      provide: PATIENT_ANSWERER,
      useFactory: (config: ConfigService) => {
        const temperature = config.get<string>('OPENAI_CHAT_TEMPERATURE');
        return createPatientAnswerer({
          model: config.get<string>('OPENAI_CHAT_MODEL') ?? undefined,
          temperature: temperature !== undefined ? Number(temperature) : undefined,
        });
      },
      inject: [ConfigService],
    },
  ],
})
export class QaModule {}
