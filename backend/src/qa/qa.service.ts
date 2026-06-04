import { Injectable, Logger } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import { PrismaService } from '../prisma/prisma.service';
import { createPatientQaAgent, SAFE_FALLBACK } from '../agents/patient-qa.agent';
import type {
  FindPatientResult,
  PatientDetail,
} from '../agents/tools/find-patient.tool';

/**
 * Response returned to the client. The agent no longer composes a prose answer — it resolves a
 * patient and the `find_patient` tool's retrieved records are surfaced directly:
 *   • patients   — the records the tool returned (0..n matches).
 *   • matchCount — patients.length (0 ⇒ nothing resolved).
 *   • fallback   — the safe-fallback string, present only when matchCount is 0.
 */
export interface QaResult {
  question: string;
  matchCount: number;
  patients: PatientDetail[];
  fallback?: string;
}

/** True when `msg` is the `find_patient` tool result. */
function isFindPatientToolMessage(msg: BaseMessage | undefined): boolean {
  if (!msg) return false;
  const type =
    typeof (msg as { getType?: () => string }).getType === 'function'
      ? (msg as { getType: () => string }).getType()
      : (msg as { _getType?: () => string })._getType?.();
  const name = (msg as { name?: string }).name;
  return type === 'tool' && name === 'find_patient';
}

/** A `ToolMessage`'s content is the JSON-stringified tool return; parse it back to the object. */
function parseToolResult(content: unknown): FindPatientResult | null {
  try {
    const text =
      typeof content === 'string' ? content : JSON.stringify(content);
    return JSON.parse(text) as FindPatientResult;
  } catch {
    return null;
  }
}

/**
 * Thin bridge between the HTTP layer and the LangChain agent. Builds the agent once
 * (stateless, reused across requests) and invokes it per question. The agent's sole job is
 * patient resolution: it calls `find_patient`, which is the terminal step — so we read the
 * tool's result straight out of the message history and return those records to the client,
 * without a second model pass. No cohort scoping yet — the search spans all patients for now.
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

    // The agent ends on the tool's output (see terminate-after-tool middleware). Scan from the
    // end for the find_patient ToolMessage and hand its records back verbatim. If the model
    // chose not to call the tool (no identifiable patient), there's no tool message → fallback.
    const messages: BaseMessage[] = result.messages;
    const toolMsg = [...messages].reverse().find(isFindPatientToolMessage);
    const toolResult = toolMsg ? parseToolResult(toolMsg.content) : null;

    if (!toolResult || toolResult.matchCount === 0) {
      return {
        question,
        matchCount: 0,
        patients: [],
        fallback: SAFE_FALLBACK,
      };
    }

    return {
      question,
      matchCount: toolResult.matchCount,
      patients: toolResult.patients,
    };
  }
}
