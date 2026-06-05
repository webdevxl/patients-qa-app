import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import {
  createFindPatientAgent,
  FIND_PATIENT_AGENT,
} from '../agents/find-patient.agent';
import {
  createAnswerPatientAgent,
  ANSWER_PATIENT_AGENT,
} from '../agents/answer-patient.agent';

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
      provide: FIND_PATIENT_AGENT,
      useFactory: (config: ConfigService) => {
        const temperature = config.get<string>('OPENAI_CHAT_TEMPERATURE');
        return createFindPatientAgent({
          model: config.get<string>('OPENAI_CHAT_MODEL') ?? undefined,
          temperature: temperature !== undefined ? Number(temperature) : undefined,
        });
      },
      inject: [ConfigService],
    },
    // The grounded answer-patient agent for the patient-scoped path — same config plumbing.
    {
      provide: ANSWER_PATIENT_AGENT,
      useFactory: (config: ConfigService) => {
        const temperature = config.get<string>('OPENAI_CHAT_TEMPERATURE');
        return createAnswerPatientAgent({
          model: config.get<string>('OPENAI_CHAT_MODEL') ?? undefined,
          temperature: temperature !== undefined ? Number(temperature) : undefined,
        });
      },
      inject: [ConfigService],
    },
  ],
})
export class QaModule {}
