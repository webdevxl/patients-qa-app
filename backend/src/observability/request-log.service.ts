import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ChatTurn, TokenUsage } from '../agents/agent-base';
import type { AnswerConfidence } from '../agents/answer-patient.agent';
import type { FindPatientsResult } from '../agents/tools/find-patients.tool';
import type { CohortGroup } from '../auth/cohort.types';

/**
 * Observability for the Q&A pipeline. One {@link RequestTrace} is assembled per request inside
 * `QaService` (mutated as signals surface) and persisted EXACTLY ONCE by {@link RequestLogService}
 * in a `finally` block, so every exit path — answered, fallback, cohort-violation, refusal, or an
 * unexpected throw — is captured. This `request_log` table is the auditable, queryable system of
 * record the eval reads; LangSmith (when on) is the complementary deep-trace layer.
 */

/** How a request ended — the eval's primary classification axis. */
export type Outcome =
  | 'answered' // ANSWER path: grounded answer returned
  | 'patients_found' // FIND path: ≥1 patient resolved/matched
  | 'no_match' // FIND path: nothing resolved/matched (or empty question)
  | 'cohort_violation' // ANSWER path: patientId unknown or in the OTHER cohort → blocked
  | 'injection_refused' // an agent's structured-output refusal terminated in a fallback
  | 'not_answerable' // ANSWER path: records genuinely don't support an answer
  | 'error'; // any thrown exception (also the seeded default, so a stray throw still logs)

/** Security severity. Monotonic via {@link bump} — a later weaker signal never lowers it. */
export type Severity = 'none' | 'low' | 'medium' | 'high';

/** A provenance reference to a source record (no PHI body — just which table + key). */
export interface SourceRef {
  table: string;
  id: string;
}

/**
 * The mutable per-request accumulator. Seeded with safe defaults (notably `outcome: 'error'`) so a
 * throw before any assignment still writes a meaningful row; fields are filled as the request runs.
 */
export interface RequestTrace {
  traceId: string;
  startedAt: number; // ms epoch; durationMs is computed at persist time
  group: CohortGroup;
  agent: string | null; // 'find-patient' | 'answer-patient' | null (no model call ran)
  question: string;
  history: ChatTurn[];
  resolvedPatientId: string | null;
  retrievalPath: 'identity' | 'attribute' | 'none';
  recordsRetrieved: SourceRef[];
  rawModelOutput: string | null;
  answer: string | null;
  confidence: AnswerConfidence | null;
  citations: string[];
  outcome: Outcome;
  fallbackUsed: boolean;
  injectionDetected: boolean;
  cohortViolation: boolean;
  severity: Severity;
  usage?: TokenUsage;
}

const SEVERITY_RANK: Record<Severity, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** Raise severity to `candidate` only if it is higher than the current level (never lowers it). */
export function bump(current: Severity, candidate: Severity): Severity {
  return SEVERITY_RANK[candidate] > SEVERITY_RANK[current] ? candidate : current;
}

/** Seed a trace with safe defaults. `outcome: 'error'` ensures an unexpected throw still logs sanely. */
export function newTrace(seed: {
  traceId: string;
  startedAt: number;
  group: CohortGroup;
  question: string;
  history: ChatTurn[];
}): RequestTrace {
  return {
    ...seed,
    agent: null,
    resolvedPatientId: null,
    retrievalPath: 'none',
    recordsRetrieved: [],
    rawModelOutput: null,
    answer: null,
    confidence: null,
    citations: [],
    outcome: 'error',
    fallbackUsed: false,
    injectionDetected: false,
    cohortViolation: false,
    severity: 'none',
  };
}

/**
 * Map a retrieval result to source-table provenance refs — the "records retrieved (with source table
 * references)" the spec requires. Stores `{ table, id }` only (NOT full PHI record bodies): the
 * patient(s), plus the matched child record's key for attribute searches.
 */
export function refsFromRetrieval(retrieval: FindPatientsResult): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const patient of retrieval.patients ?? []) {
    refs.push({ table: 'patient', id: patient.id });
  }
  for (const match of retrieval.matches ?? []) {
    refs.push({ table: 'patient', id: match.patient.id });
    if (match.matchedCondition) {
      refs.push({ table: 'patient_condition', id: match.matchedCondition.icd10Code });
    }
    if (match.matchedAllergy) {
      refs.push({ table: 'allergen', id: match.matchedAllergy.canonicalName });
    }
    if (match.matchedObservation) {
      refs.push({ table: 'patient_observation', id: match.matchedObservation.metric });
    }
    if (match.matchedMedication) {
      refs.push({
        table: 'patient_medication',
        id:
          match.matchedMedication.description ??
          match.matchedMedication.genericName ??
          'unknown',
      });
    }
  }
  return refs;
}

@Injectable()
export class RequestLogService {
  private readonly logger = new Logger(RequestLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist one request's trace. NEVER throws into the request path — observability must not turn a
   * good answer into a 500 or weaken the cohort defense, so a persist failure is logged and swallowed.
   * Awaited by the caller (inside `finally`) so the row is committed BEFORE the response is sent —
   * exactly what the eval's "was it LOGGED?" check needs.
   */
  async record(trace: RequestTrace): Promise<void> {
    try {
      await this.prisma.requestLog.create({
        data: {
          traceId: trace.traceId,
          group: trace.group,
          agent: trace.agent,
          question: trace.question,
          history: trace.history as unknown as Prisma.InputJsonValue,
          resolvedPatientId: trace.resolvedPatientId,
          retrievalPath: trace.retrievalPath,
          recordsRetrieved: trace.recordsRetrieved as unknown as Prisma.InputJsonValue,
          rawModelOutput: trace.rawModelOutput ?? Prisma.DbNull,
          answer: trace.answer,
          confidence: trace.confidence,
          citations: trace.citations as unknown as Prisma.InputJsonValue,
          outcome: trace.outcome,
          fallbackUsed: trace.fallbackUsed,
          injectionDetected: trace.injectionDetected,
          cohortViolation: trace.cohortViolation,
          severity: trace.severity,
          inputTokens: trace.usage?.inputTokens,
          outputTokens: trace.usage?.outputTokens,
          totalTokens: trace.usage?.totalTokens,
          durationMs: Date.now() - trace.startedAt,
        },
      });
    } catch (err) {
      this.logger.error(
        `📝 [${trace.traceId.slice(0, 8)}] request-log persist failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Read path for `GET /qa/logs` — recent rows, newest first, filtered by the eval's dimensions. */
  async list(opts: {
    outcome?: string;
    cohortViolation?: boolean;
    group?: string;
    agent?: string;
    limit: number;
  }) {
    const where: Prisma.RequestLogWhereInput = {};
    if (opts.outcome) where.outcome = opts.outcome;
    if (opts.group) where.group = opts.group;
    if (opts.agent) where.agent = opts.agent;
    if (opts.cohortViolation !== undefined) where.cohortViolation = opts.cohortViolation;
    return this.prisma.requestLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
    });
  }
}
