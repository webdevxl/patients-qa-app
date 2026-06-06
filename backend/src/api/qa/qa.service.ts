import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { EmbeddingsService } from '../../shared/embeddings/embeddings.service';
import {
  FIND_PATIENT_FALLBACK,
  ANSWER_FALLBACK,
  CONTEXT_WINDOW_TOKENS,
  sanitizeAndTrim,
  answerHistoryForPatient,
  type ChatTurn,
  type TokenUsage,
  type RequestUsage,
} from '../../agents/agent-base';
import {
  RequestLogService,
  newTrace,
  refsFromRetrieval,
  bump,
  type RequestTrace,
} from '../../shared/observability/request-log.service';
import {
  FIND_PATIENT_AGENT,
  type FindPatientAgent,
  type Extraction,
} from '../../agents/find-patient.agent';
import {
  ANSWER_PATIENT_AGENT,
  serializePatientForPrompt,
  type AnswerPatientAgent,
  type AnswerConfidence,
} from '../../agents/answer-patient.agent';
import {
  findPatients,
  patientInclude,
  toPatientDetail,
  type FindPatientsResult,
  type PatientDetail,
  type ConditionMatch,
} from '../../agents/tools/find-patients.tool';
import type { CohortGroup } from '../../shared/security/cohort.types';
import type { TokenSink } from './qa-stream.types';

/**
 * Response returned to the client. The model only extracts search params — it never composes
 * prose — so exactly one of the result arrays is populated by the retrieval that ran:
 *   • patients       — full records (identity lookup).
 *   • matches        — per-patient condition/allergy/measurement/medication hits (attribute search).
 *   • matchCount     — number of results (0 ⇒ nothing resolved/matched).
 *   • fallback       — the safe-fallback string, present only when matchCount is 0.
 *   • contextSummary — a COMPACT one-line summary of what resolved (e.g. "Resolved 1 patient:
 *                      Adolfo Ricker"). The client stores it and echoes it back as the assistant
 *                      turn in `history`, so follow-ups ("what about his allergies?") can resolve
 *                      references — WITHOUT re-sending full records to the model.
 *   • traceId        — correlation id, also stamped on every server log line for this request.
 *
 * When the request carries a `patientId` (a patient is already selected on the client), the SAME
 * type instead carries the grounded ANSWER about that one patient:
 *   • answer         — concise prose grounded in that patient's records.
 *   • confidence     — High/Medium/Low calibration over the supporting evidence.
 *   • citations      — the source-record labels ([C1], [M2], …) the answer relied on.
 * A patient-scoped request that can't be answered (unsupported, cross-cohort id, refusal, error)
 * still returns the safe fallback exactly like the find path.
 */
export interface QaResult {
  question: string;
  matchCount: number;
  traceId?: string;
  patients?: PatientDetail[];
  matches?: ConditionMatch[];
  fallback?: string;
  contextSummary?: string;
  // Patient-scoped answer mode (set only when the request carried a patientId):
  answer?: string;
  confidence?: AnswerConfidence;
  citations?: string[];
  /**
   * Best-effort token usage for the single LLM call this request made (the FIND path's extraction
   * or the ANSWER path's generation), surfaced for the client's chat-window usage meter. Absent only
   * when no model call ran (e.g. an empty question) — present even on a post-extraction fallback,
   * since those tokens were still spent.
   */
  usage?: RequestUsage;
}

/** Cap the question length to bound token spend / injection surface (history is capped separately). */
const MAX_QUESTION_CHARS = 2000;

const fullName = (patient: PatientDetail): string =>
  `${patient.nameFirst ?? ''} ${patient.nameLast ?? ''}`.trim() || patient.id;

/** "1 patient" / "3 patients" — count + correctly-pluralized noun, in one place (no -s/-es footgun). */
const countNoun = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`;

const joinNames = (names: string[]): string => names.join(', ');

/**
 * Human-readable description of an ATTRIBUTE search, reused by both the log line and the
 * contextSummary, e.g. `condition "diabetes" + medication metformin`. Reads only the four
 * across-patient fields (identity fields are summarized from the resolved patient list instead).
 */
function describeSearch(query: FindPatientsResult['query']): string {
  return [
    query.conditionQuery ? `condition "${query.conditionQuery}"` : null,
    query.allergyQuery ? `allergy "${query.allergyQuery}"` : null,
    query.observation ? `measurement ${query.observation}` : null,
    query.medication ? `medication ${query.medication}` : null,
  ]
    .filter(Boolean)
    .join(' + ');
}

/**
 * Thin bridge between the HTTP layer and the LangChain extractor. Per request: (1) extract search
 * params from the question + trimmed history in ONE model call, (2) route deterministically in code
 * (identity wins), (3) call the single retrieval function — scoped to the caller's cohort, (4) shape
 * the response. No second model pass; the model never sees the retrieved records. Every read is
 * confined to `group`, so a patient in the other cohort is simply never found (→ safe fallback).
 *
 * `query()` is total: any failure (extraction or retrieval) is logged and degrades to the safe
 * fallback rather than surfacing a 500 — fail-closed, so an error never leaks records or details.
 */
@Injectable()
export class QaService {
  private readonly logger = new Logger(QaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
    @Inject(FIND_PATIENT_AGENT) private readonly findPatientAgent: FindPatientAgent,
    @Inject(ANSWER_PATIENT_AGENT) private readonly answerPatientAgent: AnswerPatientAgent,
    private readonly requestLog: RequestLogService,
  ) {}

  /**
   * Compose the client-facing {@link RequestUsage} from an agent's best-effort {@link TokenUsage}
   * plus the resolved model name. Returns `undefined` when no usage was captured (no model call /
   * provider omitted it), so a result simply carries no `usage` rather than fabricated zeros. The
   * context-window budget is our own tunable constant, shared by every request.
   */
  private toRequestUsage(usage: TokenUsage | undefined, model: string): RequestUsage | undefined {
    if (!usage) return undefined;
    return { ...usage, model, contextWindow: CONTEXT_WINDOW_TOKENS };
  }

  /**
   * @param group
   * @param question
   * @param history
   * @param patientId
   * @param sessionId optional conversation id (client-minted, stable per chat). Forwarded to both the
   * find and answer agent calls so their LangSmith runs carry the same `session_id` and group into one
   * thread. Purely observability — it never changes routing or output.
   * @param onToken optional token sink. Present ONLY on the streaming endpoint (`/qa/stream`): the
   * patient-scoped ANSWER path then streams its grounded prose token-by-token (cumulative answer-so-
   * far) through it. Absent (the default, e.g. `/qa/query`) → behavior is byte-identical to before,
   * including a single trace row and the same authoritative {@link QaResult}.
   */
  async query(
    group: CohortGroup,
    question: string,
    history: ChatTurn[] = [],
    patientId?: string,
    sessionId?: string,
    onToken?: TokenSink,
  ): Promise<QaResult> {
    const traceId = randomUUID();
    const shortId = traceId.slice(0, 8);
    const startedAt = Date.now();
    const elapsed = (): number => Date.now() - startedAt;

    const trimmedQuestion = (question ?? '').trim();

    // One audit-log accumulator per request: mutated as signals surface, persisted exactly once in
    // the `finally` below (or, for the patient path, by answerAboutPatient's own finally). Seeded
    // with safe defaults (outcome: 'error') so even an unexpected throw still writes a sane row.
    const trace = newTrace({
      traceId,
      startedAt,
      group,
      question: trimmedQuestion,
      history: sanitizeAndTrim(history),
    });

    // ── Patient-scoped ANSWER path. When the client has a patient selected it pins it by id; we
    //    answer about THAT patient (re-verified under the cohort) instead of resolving one from
    //    text. Branch BEFORE extraction — there is no search to run here. The SAME trace is handed
    //    off; answerAboutPatient owns the persist, so this request logs exactly once. ──
    if (patientId) {
      return this.answerAboutPatient(group, patientId, trimmedQuestion, history, {
        traceId,
        shortId,
        elapsed,
        trace,
        sessionId,
        onToken,
      });
    }

    this.logger.log(
      `🏁 [${shortId}] qa query — cohort ${group} — "${trimmedQuestion.slice(0, 120)}" ` +
        `(history: ${history?.length ?? 0} turn(s))`,
    );

    try {
      if (!trimmedQuestion) {
        trace.outcome = 'no_match';
        trace.fallbackUsed = true;
        return this.safeFallback(question, traceId);
      }
      // Bound the prompt so an oversized question can't blow up token spend; history is already capped.
      const boundedQuestion = trimmedQuestion.slice(0, MAX_QUESTION_CHARS);

      // ── 1. Extract (the only LLM call). A malformed/failed extraction degrades to the safe
      //       fallback rather than throwing a 500. ──
      let extraction: Extraction;
      // Captured here so every downstream result — matches, identity, OR a post-extraction fallback —
      // reports the tokens this call already spent. The empty-question fallback above ran before this,
      // so it correctly carries no usage.
      let reqUsage: RequestUsage | undefined;
      try {
        trace.agent = 'find-patient';
        const extractionResult = await this.findPatientAgent.extract(boundedQuestion, history, {
          traceId,
          cohort: group,
          sessionId,
        });
        extraction = extractionResult.extraction;
        trace.rawModelOutput = extractionResult.raw ?? null;
        if (extractionResult.refused) {
          // A structured-output refusal is the extractor's injection ceiling tripping — flag it.
          trace.injectionDetected = true;
          trace.severity = bump(trace.severity, 'medium');
          this.logger.warn(`🛡️ [${shortId}] extractor refused / returned null → safe fallback`);
        }
        const usage = extractionResult.usage;
        trace.usage = usage;
        reqUsage = this.toRequestUsage(usage, this.findPatientAgent.model);
        this.logger.log(
          `🔎 [${shortId}] extracted ${JSON.stringify(extraction)} in ${elapsed()}ms` +
            (usage
              ? ` | tokens in/out/total: ${usage.inputTokens ?? '?'}/` +
                `${usage.outputTokens ?? '?'}/${usage.totalTokens ?? '?'}`
              : ''),
        );
      } catch (err) {
        this.logger.error(
          `💥 [${shortId}] extraction failed`,
          err instanceof Error ? err.stack : String(err),
        );
        trace.outcome = 'error';
        trace.severity = bump(trace.severity, 'high');
        trace.fallbackUsed = true;
        return this.safeFallback(question, traceId);
      }

      // ── 2. Retrieve via the single tool — it routes internally (identity beats a co-mentioned
      //       attribute) and returns either `patients` (identity) or `matches` (attribute). Wrapped so
      //       a DB/SQL/embeddings failure degrades to the safe fallback instead of a 500. ──
      try {
        const retrieval = await findPatients(this.prisma, this.embeddings, extraction, group);

        if (retrieval.matchCount === 0) {
          this.logger.log(
            `🚫 [${shortId}] find_patients → 0 matches (${elapsed()}ms total) → fallback`,
          );
          // If extraction refused, the cause was the injection — reflect that over a plain no-match.
          trace.outcome = trace.injectionDetected ? 'injection_refused' : 'no_match';
          trace.fallbackUsed = true;
          return this.safeFallback(question, traceId, reqUsage);
        }

        if (retrieval.patients) {
          this.logger.log(
            `👤 [${shortId}] find_patients (identity) → matchCount=${retrieval.matchCount} (${elapsed()}ms total)`,
          );
          trace.retrievalPath = 'identity';
          trace.recordsRetrieved = refsFromRetrieval(retrieval);
          trace.resolvedPatientId = retrieval.patients[0]?.id ?? null;
          trace.outcome = 'patients_found';
          return this.buildIdentityResult(question, traceId, retrieval, reqUsage);
        }

        const description = describeSearch(retrieval.query);
        this.logger.log(
          `🩺 [${shortId}] find_patients (${description}) → matchCount=${retrieval.matchCount} (${elapsed()}ms total)`,
        );
        trace.retrievalPath = 'attribute';
        trace.recordsRetrieved = refsFromRetrieval(retrieval);
        trace.outcome = 'patients_found';
        return this.buildAttributeResult(question, traceId, retrieval, description, reqUsage);
      } catch (err) {
        this.logger.error(
          `💥 [${shortId}] retrieval failed`,
          err instanceof Error ? err.stack : String(err),
        );
        // Retrieval failed AFTER extraction spent tokens — still report them.
        trace.outcome = 'error';
        trace.severity = bump(trace.severity, 'high');
        trace.fallbackUsed = true;
        return this.safeFallback(question, traceId, reqUsage);
      }
    } finally {
      // Single persist for the FIND path — guaranteed to run on every return/throw above.
      await this.requestLog.record(trace);
    }
  }

  /**
   * Patient-scoped grounded answer. The patient is already selected on the client (pinned by id);
   * we re-read THAT record under the caller's cohort and answer the question from it alone.
   *
   * Cohort isolation lives here: the `patientId` is client-supplied and never trusted on its own —
   * the `findFirst({ id, group })` re-derives the record under the token's group, so a foreign-
   * cohort or unknown id resolves to `null` ⇒ logged as a high-severity boundary event and
   * answered with the safe fallback. Like `query()`'s find path, every failure mode fails closed.
   */
  private async answerAboutPatient(
    group: CohortGroup,
    patientId: string,
    question: string,
    history: ChatTurn[],
    ctx: {
      traceId: string;
      shortId: string;
      elapsed: () => number;
      trace: RequestTrace;
      sessionId?: string;
      onToken?: TokenSink;
    },
  ): Promise<QaResult> {
    const { traceId, shortId, elapsed, trace, sessionId, onToken } = ctx;
    // The requested id is recorded up front for provenance — even if it's blocked below it's reset.
    trace.resolvedPatientId = patientId;
    this.logger.log(
      `🏁 [${shortId}] qa answer — cohort ${group} — patient ${patientId} — ` +
        `"${question.slice(0, 120)}" (history: ${history?.length ?? 0} turn(s))`,
    );

    // Assigned only once the model call returns, so it threads into the success result, the
    // not-answerable fallback, and the post-call catch — but stays undefined for the pre-call
    // fallbacks (empty question above, cohort-boundary block below), which spent no tokens.
    let reqUsage: RequestUsage | undefined;
    try {
      if (!question) {
        trace.outcome = 'no_match';
        trace.fallbackUsed = true;
        return this.safeFallback(question, traceId);
      }
      const boundedQuestion = question.slice(0, MAX_QUESTION_CHARS);

      // ── Cohort re-verification (the critical isolation defense): re-read THIS patient under the
      //    caller's group before anything else. ──
      const row = await this.prisma.patient.findFirst({
        where: { id: patientId, group },
        include: patientInclude,
      });
      if (!row) {
        // Unknown id OR a patient in the OTHER cohort — both are blocked identically. High severity:
        // this is THE cross-group event the eval queries (blocked + logged + safe fallback).
        this.logger.warn(
          `🛡️ [${shortId}] cohort boundary — patient ${patientId} not in cohort ${group} ` +
            `(unknown or cross-cohort) → blocked, safe fallback`,
        );
        trace.outcome = 'cohort_violation';
        trace.cohortViolation = true;
        trace.severity = bump(trace.severity, 'high');
        trace.fallbackUsed = true;
        trace.resolvedPatientId = null; // nothing actually resolved under this cohort
        // Keep the VERBATIM FIND_PATIENT_FALLBACK here (not ANSWER_FALLBACK): a foreign/unknown id must be
        // indistinguishable, so this block never reveals it was a cohort boundary.
        return this.safeFallback(question, traceId);
      }

      // ── Serialize the record + one grounded answer call. ──
      trace.recordsRetrieved = [{ table: 'patient', id: row.id }];
      trace.agent = 'answer-patient';
      const { context } = serializePatientForPrompt(toPatientDetail(row));
      // Feed the answerer ONLY this patient's answer-phase turns — never the find-phase chatter
      // (searches / candidate lists about OTHER patients) or a previously-selected patient's Q&A.
      const answerHistory = answerHistoryForPatient(history, patientId);
      // Stream tokens only when a sink was supplied (/qa/stream) — and only HERE, after the cohort
      // re-verify above has passed, so a blocked/unknown id never streams a single token. Both calls
      // return the identical PatientAnswerResult; everything downstream is unchanged.
      const { result, usage, refused, raw } = onToken
        ? await this.answerPatientAgent.answerStreaming(
            boundedQuestion,
            context,
            answerHistory,
            { traceId, cohort: group, sessionId },
            onToken,
          )
        : await this.answerPatientAgent.answer(boundedQuestion, context, answerHistory, {
            traceId,
            cohort: group,
            sessionId,
          });
      trace.usage = usage;
      trace.rawModelOutput = raw ?? null;
      trace.confidence = result.confidence ?? null;
      reqUsage = this.toRequestUsage(usage, this.answerPatientAgent.model);
      if (refused) {
        // A structured-output refusal is the answerer's injection ceiling tripping — flag it.
        trace.injectionDetected = true;
        trace.severity = bump(trace.severity, 'medium');
        this.logger.warn(`🛡️ [${shortId}] answerer refused / unparseable → safe fallback`);
      }
      if (!result.answerable) {
        this.logger.log(
          `🚫 [${shortId}] not answerable from patient ${patientId}'s records (${elapsed()}ms) → fallback`,
        );
        trace.outcome = trace.injectionDetected ? 'injection_refused' : 'not_answerable';
        trace.fallbackUsed = true;
        return this.safeFallback(question, traceId, reqUsage, ANSWER_FALLBACK);
      }
      // Normalize citations (strip stray brackets/space the model may add around labels).
      const citations = result.citations.map((c) => c.replace(/[[\]]/g, '').trim()).filter(Boolean);
      trace.answer = result.answer;
      trace.citations = citations;
      trace.outcome = 'answered';
      this.logger.log(
        `💬 [${shortId}] answered patient ${patientId} — confidence ${result.confidence}, ` +
          `citations [${citations.join(', ')}] (${elapsed()}ms total)` +
          (usage
            ? ` | tokens in/out/total: ${usage.inputTokens ?? '?'}/` +
              `${usage.outputTokens ?? '?'}/${usage.totalTokens ?? '?'}`
            : ''),
      );
      return {
        question,
        traceId,
        matchCount: 1,
        answer: result.answer,
        confidence: result.confidence,
        citations,
        usage: reqUsage,
      };
    } catch (err) {
      this.logger.error(
        `💥 [${shortId}] patient answer path failed (re-fetch or generation)`,
        err instanceof Error ? err.stack : String(err),
      );
      // `reqUsage` is set only if the generation call returned before throwing — so this reports
      // tokens on a post-generation failure but not on a re-fetch failure (which spent none).
      trace.outcome = 'error';
      trace.severity = bump(trace.severity, 'high');
      trace.fallbackUsed = true;
      return this.safeFallback(question, traceId, reqUsage, ANSWER_FALLBACK);
    } finally {
      // Single persist for the ANSWER path — guaranteed to run on every return/throw above.
      await this.requestLog.record(trace);
    }
  }

  /** Shape an identity (id/name) hit: full records + a compact "Resolved N patient(s): …" summary. */
  private buildIdentityResult(
    question: string,
    traceId: string,
    retrieval: FindPatientsResult,
    usage?: RequestUsage,
  ): QaResult {
    const patients = retrieval.patients ?? [];
    return {
      question,
      traceId,
      matchCount: retrieval.matchCount,
      patients,
      contextSummary:
        `Resolved ${countNoun(retrieval.matchCount, 'patient', 'patients')}: ` +
        joinNames(patients.map(fullName)),
      usage,
    };
  }

  /** Shape an attribute hit: ranked matches + a compact "Search (…) → N match(es): …" summary. */
  private buildAttributeResult(
    question: string,
    traceId: string,
    retrieval: FindPatientsResult,
    description: string,
    usage?: RequestUsage,
  ): QaResult {
    const matches = retrieval.matches ?? [];
    return {
      question,
      traceId,
      matchCount: retrieval.matchCount,
      matches,
      contextSummary:
        `Search (${description}) → ${countNoun(retrieval.matchCount, 'match', 'matches')}: ` +
        joinNames(matches.map((match) => fullName(match.patient))),
      usage,
    };
  }

  /**
   * THE safe-fallback result: no usable extraction, a retrieval that matched nothing, or any error.
   * Defaults to the verbatim FIND_PATIENT_FALLBACK string the cohort-isolation / injection design depends on;
   * the answer path overrides `fallback` with the friendlier {@link ANSWER_FALLBACK} for an
   * ungrounded answer (but NOT for its cohort-boundary block, which keeps the default). `usage` is
   * passed only when a model call already ran (so its tokens are still reported); the pre-model
   * fallbacks (empty question, cohort-boundary block) omit it.
   */
  private safeFallback(
    question: string,
    traceId: string,
    usage?: RequestUsage,
    fallback: string = FIND_PATIENT_FALLBACK,
  ): QaResult {
    return { question, traceId, matchCount: 0, fallback, usage };
  }
}
