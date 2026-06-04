import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createPatientQaAgent } from '../agents/patient-qa.agent';

export interface QaResult {
  question: string;
  answer: string;
}

/** Flatten a message's `content` (string | content-block array) to plain text. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('');
  }
  return '';
}

/**
 * Thin bridge between the HTTP layer and the LangChain agent. Builds the agent once
 * (stateless, reused across requests) and invokes it per question. No cohort scoping —
 * the agent works across all patients for now.
 */
@Injectable()
export class QaService {
  private readonly logger = new Logger(QaService.name);
  private readonly agent: ReturnType<typeof createPatientQaAgent>;

  constructor(private readonly prisma: PrismaService) {
    this.agent = createPatientQaAgent(this.prisma);
  }

  async query(question: string): Promise<QaResult> {
    this.logger.log(`qa query question=${question}`);

    const result = await this.agent.invoke({
      messages: [{ role: 'user', content: question }],
    });

    const messages = result.messages;
    const last = messages[messages.length - 1];
    const answer = messageText(last?.content);

    return { question, answer };
  }
}
