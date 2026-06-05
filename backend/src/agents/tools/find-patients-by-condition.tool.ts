import { tool } from 'langchain';
import { z } from 'zod';
import type { PrismaService } from '../../prisma/prisma.service';
import type { EmbeddingsService } from '../../embeddings/embeddings.service';
import { toVectorLiteral } from '../../embeddings/embeddings.factory';
import {
  patientInclude,
  toPatientDetail,
  type PatientDetail,
} from './find-patient.tool';

/**
 * Input schema: a single free-text clinical concept. The LLM extracts the condition/disease/
 * symptom the user is asking about (NOT a patient identifier) and we semantically match it
 * against the ICD-10 vocabulary.
 */
export const findPatientsByConditionToolSchema = z.object({
  conditionQuery: z
    .string()
    .describe(
      "The medical condition, disease, or symptom to search for, e.g. 'diabetes', " +
        "'dementia', 'chronic pain', 'Parkinson's'. The clinical concept only — never a " +
        'patient name or ID.',
    ),
});

export type FindPatientsByConditionToolInput = z.infer<
  typeof findPatientsByConditionToolSchema
>;

/**
 * One patient surfaced by the semantic condition search. Carries the patient's COMPLETE record
 * (so the client can render the full card on tap without a second request) plus which diagnosis
 * they matched on and how strongly.
 */
export interface ConditionMatch {
  patient: PatientDetail;
  /** The patient's closest-matching diagnosis for this query. */
  matchedCondition: {
    icd10Code: string;
    icd10Description: string;
    /** Cosine similarity in [-1, 1]; higher = closer. */
    similarity: number;
  };
  confidence: 'High' | 'Medium' | 'Low';
}

export interface FindPatientsByConditionResult {
  query: { conditionQuery?: string };
  matchCount: number;
  matches: ConditionMatch[];
}

/** Raw ranking row from the similarity query (one per matching diagnosis). */
interface RankRow {
  patientId: string;
  icd10Code: string;
  icd10Description: string;
  similarity: number;
}

// Minimum cosine similarity for a diagnosis to count as a match. Cosine always returns
// *something*, so without a floor we'd surface unrelated conditions (and never reach the safe
// fallback). Starting point — calibrate with the eval set. maxDistance = 1 - threshold because
// pgvector's `<=>` returns cosine DISTANCE (1 - similarity).
const SIMILARITY_THRESHOLD = 0.45;
// Distinct patients to return (mirrors find_patient's cap).
const MAX_MATCHES = 5;
// Candidate rows to pull before de-duping to distinct patients in JS. One patient can hold
// several matching diagnoses; over-fetch so we still surface MAX_MATCHES distinct people.
const CANDIDATE_LIMIT = 100;

function toConfidence(similarity: number): ConditionMatch['confidence'] {
  if (similarity >= 0.6) return 'High';
  if (similarity >= 0.5) return 'Medium';
  return 'Low';
}

/**
 * Factory: a LangChain tool that finds patients by a free-text CONDITION via semantic search.
 *
 * Flow: embed the query → cosine-rank it against the `icd_code` vocabulary (the `embedding`
 * pgvector column) → keep the best-matching diagnosis per patient → fetch those patients' FULL
 * records in one query. Each match therefore ships the complete patient record, so the client
 * renders the detail view on tap with zero extra requests. Like find_patient, this is the
 * terminal agent step — its result is returned to the client verbatim, never re-summarized.
 *
 * Cohort scoping is intentionally NOT applied (matches find_patient's current behavior); the
 * SQL marks the single predicate that re-enables it.
 */
export function createFindPatientsByConditionTool(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
) {
  return tool(
    async (
      input: FindPatientsByConditionToolInput,
    ): Promise<FindPatientsByConditionResult> => {
      const query = { conditionQuery: input.conditionQuery };
      const conditionQuery = input.conditionQuery?.trim();
      if (!conditionQuery) return { query, matchCount: 0, matches: [] };

      const qvec = toVectorLiteral(await embeddings.embedQuery(conditionQuery));
      const maxDistance = 1 - SIMILARITY_THRESHOLD;

      // Similarity-ranked candidate diagnoses. `embedding <=> $vec` is cosine distance; we
      // filter on it and expose `1 - distance` as similarity, ordered best-first.
      const rows = await prisma.$queryRaw<RankRow[]>`
        SELECT
          p.id                 AS "patientId",
          c.icd_10_code        AS "icd10Code",
          c.icd_10_description AS "icd10Description",
          1 - (ic.embedding <=> ${qvec}::vector) AS similarity
        FROM icd_code ic
        JOIN patient_condition c ON c.icd_10_code = ic.code
        JOIN patient p           ON p.id = c.patient_id
        WHERE ic.embedding IS NOT NULL
          AND (ic.embedding <=> ${qvec}::vector) <= ${maxDistance}
        -- Cohort scoping intentionally OFF (matches find_patient). To re-enable, add one
        -- predicate here:  AND p."group" = <activeCohort>
        ORDER BY similarity DESC
        LIMIT ${CANDIDATE_LIMIT}
      `;

      // Keep each patient's best (first, since similarity-desc) matched diagnosis, capped.
      const ranked: RankRow[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.patientId)) continue;
        seen.add(r.patientId);
        ranked.push(r);
        if (ranked.length >= MAX_MATCHES) break;
      }
      if (ranked.length === 0) return { query, matchCount: 0, matches: [] };

      // Fetch the full records for the ranked patients in a single query, then assemble in
      // similarity order with the matched-diagnosis metadata.
      const patients = await prisma.patient.findMany({
        where: { id: { in: ranked.map((r) => r.patientId) } },
        include: patientInclude,
      });
      const byId = new Map(patients.map((p) => [p.id, toPatientDetail(p)]));

      const matches: ConditionMatch[] = ranked
        .map((r) => {
          const patient = byId.get(r.patientId);
          if (!patient) return null;
          const similarity = Number(r.similarity);
          return {
            patient,
            matchedCondition: {
              icd10Code: r.icd10Code,
              icd10Description: r.icd10Description,
              similarity: Number(similarity.toFixed(4)),
            },
            confidence: toConfidence(similarity),
          };
        })
        .filter((m): m is ConditionMatch => m !== null);

      return { query, matchCount: matches.length, matches };
    },
    {
      name: 'find_patients_by_condition',
      description: `Find patients who have a given medical CONDITION, disease, or symptom
                    (e.g. "diabetes", "dementia", "chronic pain", "Parkinson's"). Runs a
                    semantic search over ICD-10 diagnoses, so clinical synonyms match
                    (e.g. "dementia" surfaces Alzheimer's). Pass the clinical concept ONLY —
                    never a patient name or ID. Returns matching patients with the matched
                    diagnosis and a confidence; matchCount 0 when nothing is similar enough.`,
      schema: findPatientsByConditionToolSchema,
    },
  );
}
