import { Injectable, Logger } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { createPatientQaAgent, SAFE_FALLBACK } from '../agents/patient-qa.agent';
import type {
  FindPatientResult,
  PatientDetail,
} from '../agents/tools/find-patient.tool';
import type {
  FindPatientsByConditionResult,
  ConditionMatch,
} from '../agents/tools/find-patients-by-condition.tool';

/** Tool names the agent can call; used to shape the response by which retrieval ran. */
const FIND_PATIENT = 'find_patient';
const FIND_PATIENTS_BY_CONDITION = 'find_patients_by_condition';
const TOOL_NAMES = [FIND_PATIENT, FIND_PATIENTS_BY_CONDITION];

/**
 * Response returned to the client. The agent doesn't compose prose — it routes to a retrieval
 * tool and that tool's output is surfaced directly. Exactly one of the result arrays is
 * populated depending on which tool ran:
 *   • patients   — full records (find_patient).
 *   • matches    — light per-patient condition hits (find_patients_by_condition).
 *   • matchCount — number of results (0 ⇒ nothing resolved/matched).
 *   • fallback   — the safe-fallback string, present only when matchCount is 0.
 */
export interface QaResult {
  question: string;
  matchCount: number;
  patients?: PatientDetail[];
  matches?: ConditionMatch[];
  fallback?: string;
}

/** Normalize a message's type across LangChain's `getType()` / `_getType()` variants. */
function messageType(msg: BaseMessage | undefined): string | undefined {
  if (!msg) return undefined;
  return typeof (msg as { getType?: () => string }).getType === 'function'
    ? (msg as { getType: () => string }).getType()
    : (msg as { _getType?: () => string })._getType?.();
}

/** True when `msg` is a result from one of our retrieval tools. */
function isRetrievalToolMessage(msg: BaseMessage | undefined): boolean {
  const name = (msg as { name?: string } | undefined)?.name;
  return messageType(msg) === 'tool' && !!name && TOOL_NAMES.includes(name);
}

/** A `ToolMessage`'s content is the JSON-stringified tool return; parse it back to an object. */
function parseToolResult<T>(content: unknown): T | null {
  try {
    const text =
      typeof content === 'string' ? content : JSON.stringify(content);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Thin bridge between the HTTP layer and the LangChain agent. Builds the agent once (stateless,
 * reused across requests) and invokes it per question. The agent's job is retrieval routing: it
 * calls either `find_patient` or `find_patients_by_condition`, which is the terminal step — so
 * we read that tool's result straight out of the message history and return it to the client,
 * without a second model pass. No cohort scoping yet — searches span all patients for now.
 */
@Injectable()
export class QaService {
  private readonly logger = new Logger(QaService.name);
  private readonly agent: ReturnType<typeof createPatientQaAgent>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
  ) {
    this.agent = createPatientQaAgent(this.prisma, this.embeddings);
  }

  async query(question: string): Promise<QaResult> {
    this.logger.log(`qa query question=${question}`);

    const result = await this.agent.invoke({
      messages: [{ role: 'user', content: question }],
    });

    // The agent ends on the tool's output (see terminate-after-tool middleware). Scan from the
    // end for the retrieval ToolMessage and hand its records/matches back verbatim. If the
    // model chose not to call a tool (nothing identifiable/searchable), there's no tool
    // message → fallback.
    const messages: BaseMessage[] = result.messages;
    const toolMsg = [...messages].reverse().find(isRetrievalToolMessage);
    const toolName = (toolMsg as { name?: string } | undefined)?.name;

    if (toolName === FIND_PATIENTS_BY_CONDITION) {
      const r = parseToolResult<FindPatientsByConditionResult>(toolMsg?.content);
      if (!r || r.matchCount === 0) return this.empty(question);
      return { question, matchCount: r.matchCount, matches: r.matches };
    }

    if (toolName === FIND_PATIENT) {
      const r = parseToolResult<FindPatientResult>(toolMsg?.content);
      if (!r || r.matchCount === 0) return this.empty(question);
      return { question, matchCount: r.matchCount, patients: r.patients };
    }

    return this.empty(question);
  }

  /** No tool ran, or it returned nothing → the safe fallback. */
  private empty(question: string): QaResult {
    return { question, matchCount: 0, fallback: SAFE_FALLBACK };
  }
}
