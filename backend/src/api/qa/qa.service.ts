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
  FIND_PATIENT_RESOLVERS,
  type FindPatientResolvers,
  type FindResolution,
} from '../../agents/find-resolver';
import {
  ANSWER_PATIENT_AGENTS,
  serializePatientForPrompt,
  type AnswerPatientAgents,
  type AnswerConfidence,
} from '../../agents/answer-patient.agent';
import {
  patientInclude,
  toPatientDetail,
  type FindPatientsResult,
  type PatientDetail,
  type ConditionMatch,
} from '../../agents/tools/find-patients.tool';
import type { CohortGroup } from '../../shared/security/cohort.types';
import type { AgentVariant } from '../../shared/security/variant.types';
import {
  INJECTION_GUARD_CLASSIFIER,
  type InjectionGuardClassifier,
  type GuardVerdict,
} from '../../shared/security/injection-guard.classifier';
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
   * Per-agent reasoning surfaced to the client (admin observability panel always shows them, chat
   * UI exposes them behind a disclosure). Both audit-only — never the primary user-facing prose.
   *   • extractionReasoning — FIND path only: which tokens in the message drove each search param.
   *                           Absent on the answer path (extraction didn't run), on the empty-question
   *                           pre-model fallback, or when the find agent refused before producing
   *                           structured output.
   *   • answerReasoning     — ANSWER path only: which citations support which clauses, or what was
   *                           missing on a not-answerable turn. Absent on the find path, on the
   *                           cohort-boundary block (the answerer never ran), or on a parse-failure
   *                           refusal that surfaced nothing structured.
   */
  extractionReasoning?: string;
  answerReasoning?: string;
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
    // Both A/B arms of each model stage, keyed by variant — the request's session variant selects
    // which one runs. Both arms enforce the identical cohort/injection defenses.
    @Inject(FIND_PATIENT_RESOLVERS) private readonly findResolvers: FindPatientResolvers,
    @Inject(ANSWER_PATIENT_AGENTS) private readonly answerAgents: AnswerPatientAgents,
    @Inject(INJECTION_GUARD_CLASSIFIER) private readonly injectionGuard: InjectionGuardClassifier,
    private readonly requestLog: RequestLogService,
  ) {}

  /**
   * Apply a guard verdict to the per-request audit-log trace. Shared by the find path (inline call
   * before extraction) and the answer path (via `onGuardVerdict` runtime context) so both call
   * sites stamp the same fields the same way. A `block` verdict also escalates severity, sets the
   * outcome to `injection_refused`, and marks the request as fallback-bound — the caller is
   * responsible for actually substituting the safe fallback.
   */
  private applyGuardVerdict(trace: RequestTrace, verdict: GuardVerdict): void {
    const { verdict: decision, category, confidence, reason } = verdict;
    trace.guardVerdict = decision;
    trace.guardCategory = category;
    trace.guardConfidence = confidence;
    trace.guardReason = reason;
    if (decision === 'block') {
      trace.injectionDetected = true;
      trace.severity = bump(trace.severity, 'medium');
      trace.outcome = 'injection_refused';
      trace.fallbackUsed = true;
    }
  }

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
    variant: AgentVariant,
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
      variant,
      question: trimmedQuestion,
      history: sanitizeAndTrim(history),
    });

    // ── Patient-scoped ANSWER path. When the client has a patient selected it pins it by id; we
    //    answer about THAT patient (re-verified under the cohort) instead of resolving one from
    //    text. Branch BEFORE extraction — there is no search to run here. The SAME trace is handed
    //    off; answerAboutPatient owns the persist, so this request logs exactly once. ──
    if (patientId) {
      return this.answerAboutPatient(group, variant, patientId, trimmedQuestion, history, {
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

      // ── 0. Injection guard (find path). The classifier runs BEFORE extraction, so a blocked
      //       request never reaches the bigger find model. The verdict is always stamped on the
      //       trace (allow + block alike) — the audit log is the source of truth for what the guard
      //       saw on every request. A `block` substitutes the verbatim safe fallback; the trace's
      //       `outcome` / `injectionDetected` / `severity` are already set by `applyGuardVerdict`. ──
      const guardVerdict = await this.injectionGuard.classify(boundedQuestion);
      this.applyGuardVerdict(trace, guardVerdict);
      if (guardVerdict.verdict === 'block') {
        this.logger.warn(
          `🛡️ [${shortId}] injection-guard BLOCK (${guardVerdict.category}, ${guardVerdict.confidence}) → safe fallback`,
        );
        return this.safeFallback(question, traceId);
      }

      // ── 1. Resolve the FIND stage via the session's A/B arm. Both arms return the SAME
      //       FindPatientsResult — the 'structured' arm extracts search params then routes the
      //       retrieval in code; the 'tool_calling' arm lets the LLM drive the `find_patients` tool.
      //       Cohort scoping is identical (the retrieval is confined to `group` either way). A
      //       failure in EITHER step degrades to the safe fallback rather than throwing a 500. ──
      const resolver = this.findResolvers[variant];
      // Captured so every downstream result — matches, identity, OR a post-resolve fallback — reports
      // the tokens this call already spent. The empty-question fallback above ran before this, so it
      // correctly carries no usage.
      let reqUsage: RequestUsage | undefined;
      let resolution: FindResolution;
      try {
        trace.agent = 'find-patient';
        resolution = await resolver.resolve(boundedQuestion, history, group, {
          traceId,
          cohort: group,
          sessionId,
          variant,
        });
      } catch (err) {
        this.logger.error(
          `💥 [${shortId}] find resolve failed`,
          err instanceof Error ? err.stack : String(err),
        );
        trace.outcome = 'error';
        trace.severity = bump(trace.severity, 'high');
        trace.fallbackUsed = true;
        return this.safeFallback(question, traceId);
      }

      // ── 2. Shape the result. Pure code (no model/DB calls) → cannot throw. ──
      const retrieval = resolution.retrieval;
      trace.rawModelOutput = resolution.raw ?? null;
      // Audit-log + client-facing rationale for the search params (the structured arm writes one; the
      // tool arm has none → null). Threaded into every downstream find-path return.
      trace.extractionReasoning = resolution.reasoning ?? null;
      const extractionReasoning = resolution.reasoning ?? undefined;
      if (resolution.refused) {
        // A structured-output refusal is the extractor's injection ceiling tripping — flag it.
        trace.injectionDetected = true;
        trace.severity = bump(trace.severity, 'medium');
        this.logger.warn(`🛡️ [${shortId}] find resolver refused / returned nothing → safe fallback`);
      }
      const usage = resolution.usage;
      trace.usage = usage;
      reqUsage = this.toRequestUsage(usage, resolver.model);
      this.logger.log(
        `🔎 [${shortId}] resolved (${variant}) → matchCount=${retrieval.matchCount} in ${elapsed()}ms` +
          (usage
            ? ` | tokens in/out/total: ${usage.inputTokens ?? '?'}/` +
              `${usage.outputTokens ?? '?'}/${usage.totalTokens ?? '?'}`
            : ''),
      );

      if (retrieval.matchCount === 0) {
        this.logger.log(`🚫 [${shortId}] find → 0 matches (${elapsed()}ms total) → fallback`);
        // If the resolver refused, the cause was the injection — reflect that over a plain no-match.
        trace.outcome = trace.injectionDetected ? 'injection_refused' : 'no_match';
        trace.fallbackUsed = true;
        return this.safeFallback(question, traceId, reqUsage, FIND_PATIENT_FALLBACK, {
          extractionReasoning,
        });
      }

      if (retrieval.patients) {
        this.logger.log(
          `👤 [${shortId}] find (identity) → matchCount=${retrieval.matchCount} (${elapsed()}ms total)`,
        );
        trace.retrievalPath = 'identity';
        trace.recordsRetrieved = refsFromRetrieval(retrieval);
        trace.resolvedPatientId = retrieval.patients[0]?.id ?? null;
        trace.outcome = 'patients_found';
        return this.buildIdentityResult(question, traceId, retrieval, reqUsage, extractionReasoning);
      }

      const description = describeSearch(retrieval.query);
      this.logger.log(
        `🩺 [${shortId}] find (${description}) → matchCount=${retrieval.matchCount} (${elapsed()}ms total)`,
      );
      trace.retrievalPath = 'attribute';
      trace.recordsRetrieved = refsFromRetrieval(retrieval);
      trace.outcome = 'patients_found';
      return this.buildAttributeResult(
        question,
        traceId,
        retrieval,
        description,
        reqUsage,
        extractionReasoning,
      );
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
    variant: AgentVariant,
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
      // The injection-guard middleware (`beforeAgent`) on the answer agent classifies the
      // clinician's question and short-circuits on `block` (jumpTo: 'end'). The verdict is reported
      // back here via this callback, so the audit-log trace stamps every guard decision — and a
      // BLOCK log line surfaces in the server log next to the existing 🛡️ cohort / refusal lines.
      const onGuardVerdict = (verdict: GuardVerdict): void => {
        this.applyGuardVerdict(trace, verdict);
        if (verdict.verdict === 'block') {
          this.logger.warn(
            `🛡️ [${shortId}] injection-guard BLOCK (${verdict.category}, ${verdict.confidence}) → safe fallback`,
          );
        }
      };
      // Select the answer agent for this request's A/B arm. Both arms enforce the SAME injection
      // guard + see only this one cohort-verified patient — the tool-calling arm just pulls the
      // record via a tool instead of receiving it inline.
      const answerAgent = this.answerAgents[variant];
      // Stream tokens only when a sink was supplied (/qa/stream) — and only HERE, after the cohort
      // re-verify above has passed, so a blocked/unknown id never streams a single token. Both calls
      // return the identical PatientAnswerResult; everything downstream is unchanged.
      const { result, usage, refused, raw } = onToken
        ? await answerAgent.answerStreaming(
            boundedQuestion,
            context,
            answerHistory,
            { traceId, cohort: group, sessionId, variant, onGuardVerdict },
            onToken,
          )
        : await answerAgent.answer(boundedQuestion, context, answerHistory, {
            traceId,
            cohort: group,
            sessionId,
            variant,
            onGuardVerdict,
          });
      trace.usage = usage;
      trace.rawModelOutput = raw ?? null;
      trace.confidence = result.confidence ?? null;
      // The schema makes `reasoning` a required non-null string, but `UNANSWERABLE` carries `''` —
      // collapse the empty case to null on the trace, and to undefined on the wire (the client field
      // is optional).
      const answerReasoning = result.reasoning?.trim() ? result.reasoning : null;
      trace.answerReasoning = answerReasoning;
      reqUsage = this.toRequestUsage(usage, answerAgent.model);
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
        // Carry the answerer's reasoning on the fallback too — it's the most useful audit signal here
        // ("record has no observations for blood pressure"). Empty/null is fine; the client just hides it.
        return this.safeFallback(question, traceId, reqUsage, ANSWER_FALLBACK, {
          answerReasoning: answerReasoning ?? undefined,
        });
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
        answerReasoning: answerReasoning ?? undefined,
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
    extractionReasoning?: string,
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
      extractionReasoning,
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
    extractionReasoning?: string,
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
      extractionReasoning,
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
   *
   * `reasoning` carries the per-agent rationale that was already collected on the trace — surfaced
   * to the client so the admin Sheet and chat disclosure can show *why* even on a fallback (e.g. an
   * unanswerable answer-path turn can still explain what was missing). Cohort-boundary blocks and
   * empty-question fallbacks omit it — nothing was reasoned.
   */
  private safeFallback(
    question: string,
    traceId: string,
    usage?: RequestUsage,
    fallback: string = FIND_PATIENT_FALLBACK,
    reasoning: { extractionReasoning?: string; answerReasoning?: string } = {},
  ): QaResult {
    return {
      question,
      traceId,
      matchCount: 0,
      fallback,
      extractionReasoning: reasoning.extractionReasoning,
      answerReasoning: reasoning.answerReasoning,
      usage,
    };
  }
}
