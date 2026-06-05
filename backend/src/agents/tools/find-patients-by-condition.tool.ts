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
 * Input schema: two optional free-text concepts. The LLM extracts whichever the question is
 * about and we semantically match it against the matching vocabulary:
 *   • conditionQuery → ICD-10 diagnoses ("which patients have diabetes?")
 *   • allergyQuery   → the canonical allergen dictionary ("who is allergic to penicillin?")
 * Set whichever applies — usually one, but BOTH when the question asks about a condition AND an
 * allergy together ("diabetics allergic to penicillin"); then we search both and a single match
 * carries both hits. Neither is ever a patient name/ID — that's the job of find_patient.
 */
export const findPatientsByConditionToolSchema = z.object({
  conditionQuery: z
    .string()
    .optional()
    .describe(
      "The medical condition, disease, or symptom to search for, e.g. 'diabetes', " +
        "'dementia', 'chronic pain', 'Parkinson's'. The clinical concept only — never a " +
        'patient name or ID. Omit for pure allergy questions.',
    ),
  allergyQuery: z
    .string()
    .optional()
    .describe(
      "The allergen or substance the patient is ALLERGIC to, e.g. 'penicillin', " +
        "'sulfa antibiotics', 'codeine', 'iodine', 'aspirin'. The substance only — never a " +
        'patient name or ID. Set this for any allergy ("allergic to X", "has an allergy to X"); ' +
        'combine with conditionQuery when the question asks about both.',
    ),
});

export type FindPatientsByConditionToolInput = z.infer<
  typeof findPatientsByConditionToolSchema
>;

/**
 * One patient surfaced by the semantic search. Carries the patient's COMPLETE record (so the
 * client can render the full card on tap without a second request) plus what they matched on
 * and how strongly. Exactly one of `matchedCondition` / `matchedAllergy` is set per match,
 * depending on which search produced it.
 */
export interface ConditionMatch {
  patient: PatientDetail;
  /** The patient's closest-matching diagnosis (set for condition searches). */
  matchedCondition?: {
    icd10Code: string;
    icd10Description: string;
    /** Cosine similarity in [-1, 1]; higher = closer. */
    similarity: number;
  };
  /** The patient's closest-matching allergen (set for allergy searches). */
  matchedAllergy?: {
    canonicalName: string;
    category: string | null;
    /** Cosine similarity in [-1, 1]; higher = closer. */
    similarity: number;
  };
  confidence: 'High' | 'Medium' | 'Low';
}

export interface FindPatientsByConditionResult {
  query: { conditionQuery?: string; allergyQuery?: string };
  matchCount: number;
  matches: ConditionMatch[];
}

/** Raw ranking row from the condition similarity query (one per matching diagnosis). */
interface ConditionRankRow {
  patientId: string;
  icd10Code: string;
  icd10Description: string;
  similarity: number;
}

/** Raw ranking row from the allergy similarity query (one per matching allergen). */
interface AllergyRankRow {
  patientId: string;
  canonicalName: string;
  category: string | null;
  similarity: number;
}

/**
 * Per-patient accumulator: a patient's best condition hit and/or best allergy hit. A patient
 * surfaced by BOTH searches carries both, so the match can report a condition AND an allergy.
 */
interface Candidate {
  patientId: string;
  matchedCondition?: ConditionMatch['matchedCondition'];
  matchedAllergy?: ConditionMatch['matchedAllergy'];
}

// Minimum cosine similarity for a hit to count. Cosine always returns *something*, so without a
// floor we'd surface unrelated rows (and never reach the safe fallback). Starting point —
// calibrate with the eval set. maxDistance = 1 - threshold because pgvector's `<=>` returns
// cosine DISTANCE (1 - similarity).
const SIMILARITY_THRESHOLD = 0.45;
// Distinct patients to return (mirrors find_patient's cap).
const MAX_MATCHES = 5;
// Candidate rows to pull per search before de-duping to distinct patients in JS. One patient can
// hold several matching rows; over-fetch so we still surface MAX_MATCHES distinct people.
const CANDIDATE_LIMIT = 100;

function toConfidence(similarity: number): ConditionMatch['confidence'] {
  if (similarity >= 0.6) return 'High';
  if (similarity >= 0.5) return 'Medium';
  return 'Low';
}

/**
 * Factory: a LangChain tool that finds patients by a free-text CONDITION or ALLERGY via semantic
 * search.
 *
 * Flow: embed the query → cosine-rank it against the matching vocabulary (the `embedding`
 * pgvector column on `icd_code` for conditions, on `allergen` for allergies) → keep the best
 * match per patient → fetch those patients' FULL records in one query. Each match therefore
 * ships the complete patient record, so the client renders the detail view on tap with zero
 * extra requests. Like find_patient, this is the terminal agent step — its result is returned
 * to the client verbatim, never re-summarized.
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
      const query = {
        conditionQuery: input.conditionQuery,
        allergyQuery: input.allergyQuery,
      };
      const conditionQuery = input.conditionQuery?.trim();
      const allergyQuery = input.allergyQuery?.trim();
      if (!conditionQuery && !allergyQuery) {
        return { query, matchCount: 0, matches: [] };
      }

      const maxDistance = 1 - SIMILARITY_THRESHOLD;
      // Accumulate each patient's best condition hit and best allergy hit. A patient surfaced by
      // BOTH searches gets ONE match carrying both. The SQL returns rows similarity-desc, so the
      // first row seen per patient/field is their strongest match for that field.
      const byPatient = new Map<string, Candidate>();
      const upsert = (patientId: string): Candidate => {
        let c = byPatient.get(patientId);
        if (!c) {
          c = { patientId };
          byPatient.set(patientId, c);
        }
        return c;
      };

      // ── Condition search: rank patient diagnoses against the ICD-10 vocabulary. ──
      if (conditionQuery) {
        const qvec = toVectorLiteral(await embeddings.embedQuery(conditionQuery));
        // `embedding <=> $vec` is cosine distance; filter on it and expose `1 - distance` as
        // similarity, ordered best-first.
        const rows = await prisma.$queryRaw<ConditionRankRow[]>`
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
        for (const r of rows) {
          const c = upsert(r.patientId);
          if (!c.matchedCondition) {
            c.matchedCondition = {
              icd10Code: r.icd10Code,
              icd10Description: r.icd10Description,
              similarity: Number(r.similarity),
            };
          }
        }
      }

      // ── Allergy search: rank patient allergies against the canonical allergen vocabulary. ──
      if (allergyQuery) {
        const qvec = toVectorLiteral(await embeddings.embedQuery(allergyQuery));
        const rows = await prisma.$queryRaw<AllergyRankRow[]>`
          SELECT
            p.id             AS "patientId",
            a.canonical_name AS "canonicalName",
            a.category       AS "category",
            1 - (a.embedding <=> ${qvec}::vector) AS similarity
          FROM allergen a
          JOIN patient_allergy pa ON pa.allergen_id = a.id
          JOIN patient p          ON p.id = pa.patient_id
          WHERE a.embedding IS NOT NULL
            AND (a.embedding <=> ${qvec}::vector) <= ${maxDistance}
          -- Cohort scoping intentionally OFF (matches find_patient). To re-enable, add one
          -- predicate here:  AND p."group" = <activeCohort>
          ORDER BY similarity DESC
          LIMIT ${CANDIDATE_LIMIT}
        `;
        for (const r of rows) {
          const c = upsert(r.patientId);
          if (!c.matchedAllergy) {
            c.matchedAllergy = {
              canonicalName: r.canonicalName,
              category: r.category,
              similarity: Number(r.similarity),
            };
          }
        }
      }

      // Rank patients by their strongest hit (max of condition/allergy similarity), capped.
      const bestSimilarity = (c: Candidate): number =>
        Math.max(
          c.matchedCondition?.similarity ?? -1,
          c.matchedAllergy?.similarity ?? -1,
        );
      const ranked = [...byPatient.values()]
        .sort((a, b) => bestSimilarity(b) - bestSimilarity(a))
        .slice(0, MAX_MATCHES);
      if (ranked.length === 0) return { query, matchCount: 0, matches: [] };

      // Fetch the full records for the ranked patients in a single query, then assemble in
      // similarity order with whichever matched-row metadata applies.
      const patients = await prisma.patient.findMany({
        where: { id: { in: ranked.map((r) => r.patientId) } },
        include: patientInclude,
      });
      const byId = new Map(patients.map((p) => [p.id, toPatientDetail(p)]));

      const matches: ConditionMatch[] = ranked
        .map((c): ConditionMatch | null => {
          const patient = byId.get(c.patientId);
          if (!patient) return null;
          const matchedCondition = c.matchedCondition
            ? {
                ...c.matchedCondition,
                similarity: Number(c.matchedCondition.similarity.toFixed(4)),
              }
            : undefined;
          const matchedAllergy = c.matchedAllergy
            ? {
                ...c.matchedAllergy,
                similarity: Number(c.matchedAllergy.similarity.toFixed(4)),
              }
            : undefined;
          return {
            patient,
            matchedCondition,
            matchedAllergy,
            confidence: toConfidence(bestSimilarity(c)),
          };
        })
        .filter((m): m is ConditionMatch => m !== null);

      return { query, matchCount: matches.length, matches };
    },
    {
      name: 'find_patients_by_condition',
      description: `Find patients who have a given medical CONDITION/disease/symptom and/or an
                    ALLERGY to a drug/substance. Runs a semantic search, so clinical synonyms
                    match (e.g. "dementia" surfaces Alzheimer's). Set the argument(s) that apply:
                    • conditionQuery for a disease/symptom ("which patients have diabetes?",
                      "who has chronic pain?").
                    • allergyQuery for an allergy ("who is allergic to penicillin?", "find
                      patients allergic to sulfa") — pass the substance only.
                    • BOTH when the question combines them ("diabetics allergic to penicillin").
                    Pass the clinical concept / substance ONLY — never a patient name or ID.
                    Returns matching patients with the matched diagnosis and/or allergen and a
                    confidence; matchCount 0 when nothing is similar enough.`,
      schema: findPatientsByConditionToolSchema,
    },
  );
}
