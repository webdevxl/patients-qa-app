import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { EmbeddingsService } from '../../shared/embeddings/embeddings.service';
import { EmbeddingsModule } from '../../shared/embeddings/embeddings.module';
import { ObservabilityModule } from '../../shared/observability/observability.module';
import { FIND_PATIENT_RESOLVERS, type FindPatientResolvers } from '../../agents/core/find.contract';
import { ANSWER_PATIENT_AGENTS, type AnswerPatientAgents } from '../../agents/core/answer.contract';
import {
  createFindPatientAgent,
  createStructuredFindResolver,
} from '../../agents/variants/structured/find-patient.agent';
import { createToolCallingFindResolver } from '../../agents/variants/tool-calling/find-patient.agent';
import { createAnswerPatientAgent } from '../../agents/variants/structured/answer-patient.agent';
import { createAnswerPatientAgentToolCalling } from '../../agents/variants/tool-calling/answer-patient.agent';
import {
  createInjectionGuardClassifier,
  INJECTION_GUARD_CLASSIFIER,
  type InjectionGuardClassifier,
} from '../../shared/security/injection-guard.classifier';
import type { ChatModelOptions } from '../../agents/core/agent-base';

/** Shared chat-model tuning from env (model + temperature), with the factory defaults as fallback. */
function chatOptions(config: ConfigService): ChatModelOptions {
  const temperature = config.get<string>('OPENAI_CHAT_TEMPERATURE');
  return {
    model: config.get<string>('OPENAI_CHAT_MODEL') ?? undefined,
    temperature: temperature !== undefined ? Number(temperature) : undefined,
  };
}

// PrismaService is available via the @Global() PrismaModule — no import needed in `imports`.
// EmbeddingsModule provides the OpenAI embeddings client for attribute search.
@Module({
  imports: [EmbeddingsModule, ObservabilityModule],
  controllers: [QaController],
  providers: [
    QaService,
    // The injection-guard classifier — a small, opt-in LLM call that scores each user message for
    // prompt-injection / cross-cohort access. Unset OPENAI_GUARD_MODEL ⇒ no-op classifier (zero
    // tokens, zero latency). Wired BEFORE the answer agents so it can be injected into their factory.
    {
      provide: INJECTION_GUARD_CLASSIFIER,
      useFactory: (config: ConfigService) => {
        const temperature = config.get<string>('OPENAI_GUARD_TEMPERATURE');
        return createInjectionGuardClassifier({
          model: config.get<string>('OPENAI_GUARD_MODEL') ?? undefined,
          temperature: temperature !== undefined ? Number(temperature) : undefined,
        });
      },
      inject: [ConfigService],
    },
    // Both A/B arms of the FIND stage, keyed by variant. 'structured' = the existing extractor +
    // code routing; 'tool_calling' = an LLM-driven `find_patients` agent. Both scope every read to
    // the caller's cohort, so neither can leak across groups. QaService picks per request.
    {
      provide: FIND_PATIENT_RESOLVERS,
      useFactory: (
        config: ConfigService,
        prisma: PrismaService,
        embeddings: EmbeddingsService,
      ): FindPatientResolvers => {
        const opts = chatOptions(config);
        return {
          structured: createStructuredFindResolver(createFindPatientAgent(opts), prisma, embeddings),
          tool_calling: createToolCallingFindResolver(prisma, embeddings, opts),
        };
      },
      inject: [ConfigService, PrismaService, EmbeddingsService],
    },
    // Both A/B arms of the ANSWER stage, keyed by variant. 'structured' = the zero-tool
    // structured-output agent; 'tool_calling' = an agent that pulls the (already cohort-verified)
    // record via a `get_patient_record` tool. Both run the SAME injection-guard middleware.
    {
      provide: ANSWER_PATIENT_AGENTS,
      useFactory: (
        config: ConfigService,
        classifier: InjectionGuardClassifier,
      ): AnswerPatientAgents => {
        const opts = chatOptions(config);
        return {
          structured: createAnswerPatientAgent(opts, classifier),
          tool_calling: createAnswerPatientAgentToolCalling(opts, classifier),
        };
      },
      inject: [ConfigService, INJECTION_GUARD_CLASSIFIER],
    },
  ],
})
export class QaModule {}
