import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ChatTurn, TokenUsage } from '../../agents/core/agent-base';
import type { AnswerConfidence } from '../../agents/core/answer.contract';
import type { FindPatientsResult } from '../../agents/core/tools/find-patients.tool';
import type { CohortGroup } from '../security/cohort.types';
import { AGENT_VARIANTS, type AgentVariant } from '../security/variant.types';

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

/** Injection-guard decision for one request — mirrors {@link GuardVerdict.verdict}. */
export type GuardDecision = 'allow' | 'block';
/** Injection-guard confidence — mirrors {@link GuardVerdict.confidence}. */
export type GuardConfidence = 'high' | 'medium' | 'low';

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
  variant: AgentVariant; // A/B arm this request was routed to ('structured' | 'tool_calling')
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
  // ── Model reasoning (one short rationale per agent that actually ran). Audit-only — these are
  //    NOT user-facing prose: the find-patient agent explains why it picked the search params, the
  //    answer-patient agent explains how each clause was grounded (or what was missing on refusal).
  //    null when that agent never ran or refused before producing structured output. ──
  extractionReasoning: string | null;
  answerReasoning: string | null;
  outcome: Outcome;
  fallbackUsed: boolean;
  injectionDetected: boolean;
  cohortViolation: boolean;
  severity: Severity;
  // ── Injection-guard verdict (the SMALL classifier run BEFORE the main agent, see
  //    `injection-guard.classifier.ts`). null when the guard didn't run (e.g. empty question).
  //    A `block` verdict also escalates `injectionDetected` + `severity` + `outcome`; the verdict
  //    columns themselves are the AUDITABLE per-request record of what the guard decided. ──
  guardVerdict?: GuardDecision | null;
  guardCategory?: string | null;
  guardConfidence?: GuardConfidence | null;
  guardReason?: string | null;
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
  variant: AgentVariant;
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
    extractionReasoning: null,
    answerReasoning: null,
    outcome: 'error',
    fallbackUsed: false,
    injectionDetected: false,
    cohortViolation: false,
    severity: 'none',
    guardVerdict: null,
    guardCategory: null,
    guardConfidence: null,
    guardReason: null,
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
          variant: trace.variant,
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
          extractionReasoning: trace.extractionReasoning,
          answerReasoning: trace.answerReasoning,
          outcome: trace.outcome,
          fallbackUsed: trace.fallbackUsed,
          injectionDetected: trace.injectionDetected,
          cohortViolation: trace.cohortViolation,
          severity: trace.severity,
          guardVerdict: trace.guardVerdict ?? null,
          guardCategory: trace.guardCategory ?? null,
          guardConfidence: trace.guardConfidence ?? null,
          guardReason: trace.guardReason ?? null,
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
    variant?: string;
    agent?: string;
    limit: number;
  }) {
    const where: Prisma.RequestLogWhereInput = {};
    if (opts.outcome) where.outcome = opts.outcome;
    if (opts.group) where.group = opts.group;
    if (opts.variant) where.variant = opts.variant;
    if (opts.agent) where.agent = opts.agent;
    if (opts.cohortViolation !== undefined) where.cohortViolation = opts.cohortViolation;
    return this.prisma.requestLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
    });
  }

  /**
   * Per-variant experiment metrics for `GET /qa/metrics` — the A/B test's "basic experiment metrics
   * per variant" (task §4). One pass per arm: counts the rows, the outcome/confidence distributions,
   * the safety flags, and averages the token + latency columns straight from the audit log (the
   * system of record), so the numbers are exactly what was logged — no separate metrics store to
   * drift. Empty arms report zeros rather than being omitted, so the comparison always has both rows.
   */
  async metricsByVariant(): Promise<VariantMetrics[]> {
    return Promise.all(AGENT_VARIANTS.map((variant) => this.metricsForVariant(variant)));
  }

  private async metricsForVariant(variant: AgentVariant): Promise<VariantMetrics> {
    const where: Prisma.RequestLogWhereInput = { variant };

    const [total, byOutcome, byConfidence, fallbacks, injections, violations, agg] =
      await Promise.all([
        this.prisma.requestLog.count({ where }),
        this.prisma.requestLog.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
        this.prisma.requestLog.groupBy({
          by: ['confidence'],
          where: { ...where, confidence: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.requestLog.count({ where: { ...where, fallbackUsed: true } }),
        this.prisma.requestLog.count({ where: { ...where, injectionDetected: true } }),
        this.prisma.requestLog.count({ where: { ...where, cohortViolation: true } }),
        this.prisma.requestLog.aggregate({
          where,
          _avg: { inputTokens: true, outputTokens: true, totalTokens: true, durationMs: true },
        }),
      ]);

    const toMap = (rows: { _count: { _all: number } }[], key: (r: any) => string): Record<string, number> =>
      Object.fromEntries(rows.map((r) => [key(r), r._count._all]));

    const round = (n: number | null): number | null => (n == null ? null : Math.round(n));

    return {
      variant,
      total,
      outcomes: toMap(byOutcome, (r) => r.outcome),
      confidence: toMap(byConfidence, (r) => r.confidence ?? 'null'),
      fallbackUsed: fallbacks,
      injectionDetected: injections,
      cohortViolation: violations,
      avgInputTokens: round(agg._avg.inputTokens),
      avgOutputTokens: round(agg._avg.outputTokens),
      avgTotalTokens: round(agg._avg.totalTokens),
      avgDurationMs: round(agg._avg.durationMs),
    };
  }
}

/** One arm's aggregated experiment metrics (shape returned by `GET /qa/metrics`). */
export interface VariantMetrics {
  variant: AgentVariant;
  total: number;
  /** Count by `outcome` (answered / patients_found / no_match / cohort_violation / …). */
  outcomes: Record<string, number>;
  /** Count by answer `confidence` (High / Medium / Low) over rows that produced one. */
  confidence: Record<string, number>;
  fallbackUsed: number;
  injectionDetected: number;
  cohortViolation: number;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  avgTotalTokens: number | null;
  avgDurationMs: number | null;
}
