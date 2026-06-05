import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import {
  createPatientQaExtractor,
  SAFE_FALLBACK,
  type PatientQaExtractor,
  type ChatTurn,
} from '../agents/patient-qa.agent';
import {
  findPatients,
  type FindPatientsResult,
  type PatientDetail,
  type ConditionMatch,
} from '../agents/tools/find-patients.tool';
import type { CohortGroup } from '../auth/cohort.types';

/**
 * Response returned to the client. The model only extracts search params — it never composes
 * prose — so exactly one of the result arrays is populated by the retrieval that ran:
 *   • patients       — full records (findPatient).
 *   • matches        — per-patient condition/allergy hits (findPatientsByCondition).
 *   • matchCount     — number of results (0 ⇒ nothing resolved/matched).
 *   • fallback       — the safe-fallback string, present only when matchCount is 0.
 *   • contextSummary — a COMPACT one-line summary of what resolved (e.g. "Resolved patient:
 *                      Adolfo Ricker"). The client stores it and echoes it back as the assistant
 *                      turn in `history`, so follow-ups ("what about his allergies?") can resolve
 *                      references — WITHOUT re-sending full records to the model.
 */
export interface QaResult {
  question: string;
  matchCount: number;
  patients?: PatientDetail[];
  matches?: ConditionMatch[];
  fallback?: string;
  contextSummary?: string;
}

const fullName = (p: PatientDetail): string =>
  `${p.nameFirst ?? ''} ${p.nameLast ?? ''}`.trim() || p.id;

/**
 * Thin bridge between the HTTP layer and the LangChain extractor. Builds the stateless extractor
 * once and, per request: (1) extracts search params from the question + trimmed history in ONE
 * model call, (2) routes deterministically in code (identity wins), (3) calls the matching
 * retrieval function — scoped to the caller's cohort, (4) shapes the response. No second model
 * pass; the model never sees the retrieved records. Every read is confined to `group`, so a
 * patient in the other cohort is simply never found (→ safe fallback).
 */
@Injectable()
export class QaService {
  private readonly logger = new Logger(QaService.name);
  private readonly extractor: PatientQaExtractor = createPatientQaExtractor();

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  async query(
    group: CohortGroup,
    question: string,
    history: ChatTurn[] = [],
  ): Promise<QaResult> {
    const traceId = randomUUID().slice(0, 8);
    const startedAt = Date.now();
    this.logger.log(
      `🏁 [${traceId}] qa query — cohort ${group} — "${question}" (history: ${history.length} turn(s))`,
    );

    // ── 1. Extract (the only LLM call). A malformed/failed extraction degrades to the safe
    //       fallback rather than throwing a 500. ──
    let extraction;
    try {
      const res = await this.extractor.extract(question, history);
      extraction = res.extraction;
      const u = res.usage;
      this.logger.log(
        `🔎 [${traceId}] extracted ${JSON.stringify(extraction)} in ` +
          `${Date.now() - startedAt}ms` +
          (u ? ` | tokens in/out/total: ${u.inputTokens ?? '?'}/${u.outputTokens ?? '?'}/${u.totalTokens ?? '?'}` : ''),
      );
    } catch (err) {
      this.logger.error(`💥 [${traceId}] extraction failed: ${String(err)}`);
      return this.empty(question);
    }

    // ── 2. Retrieve via the single tool — it routes internally (identity beats a co-mentioned
    //       condition/allergy) and returns either `patients` (identity) or `matches` (attribute). ──
    const r: FindPatientsResult = await findPatients(
      this.prisma,
      this.embeddings,
      extraction,
      group,
    );

    if (r.matchCount === 0) {
      this.logger.log(
        `🚫 [${traceId}] find_patients → 0 matches (${Date.now() - startedAt}ms total) → fallback`,
      );
      return this.empty(question);
    }

    if (r.patients) {
      this.logger.log(
        `👤 [${traceId}] find_patients (identity) → matchCount=${r.matchCount} (${Date.now() - startedAt}ms total)`,
      );
      return {
        question,
        matchCount: r.matchCount,
        patients: r.patients,
        contextSummary: `Resolved ${r.matchCount} patient${r.matchCount === 1 ? '' : 's'}: ${r.patients
          .map(fullName)
          .join(', ')}`,
      };
    }

    // Attribute search → `matches`.
    const matches = r.matches ?? [];
    const what = [
      r.query.conditionQuery ? `condition "${r.query.conditionQuery}"` : null,
      r.query.allergyQuery ? `allergy "${r.query.allergyQuery}"` : null,
    ]
      .filter(Boolean)
      .join(' + ');
    this.logger.log(
      `🩺 [${traceId}] find_patients (${what}) → matchCount=${r.matchCount} (${Date.now() - startedAt}ms total)`,
    );
    return {
      question,
      matchCount: r.matchCount,
      matches,
      contextSummary: `Search (${what}) → ${r.matchCount} match${r.matchCount === 1 ? '' : 'es'}: ${matches
        .map((m) => fullName(m.patient))
        .join(', ')}`,
    };
  }

  /** No usable extraction, or a retrieval returned nothing → the safe fallback. */
  private empty(question: string): QaResult {
    return { question, matchCount: 0, fallback: SAFE_FALLBACK };
  }
}
