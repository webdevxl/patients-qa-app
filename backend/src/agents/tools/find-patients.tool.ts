import { tool } from 'langchain';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { EmbeddingsService } from '../../embeddings/embeddings.service';
import { toVectorLiteral } from '../../embeddings/embeddings.factory';

/**
 * THE single patient-retrieval tool. It resolves patients two ways and the caller need not choose
 * between two tools — `findPatients` routes internally (identity wins):
 *   • by IDENTITY  — patientId and/or name → exact DB lookup, returns FULL records (`patients`).
 *   • by ATTRIBUTE — conditionQuery and/or allergyQuery → semantic pgvector search, returns ranked
 *                    `matches` (each with the matched diagnosis/allergen + a confidence).
 * A specific patient (id/name) always beats a co-mentioned condition/allergy, so
 * "Is John Smith allergic to penicillin?" resolves the person, not an allergy search.
 *
 * Exactly one of `patients` / `matches` is populated per call (or neither ⇒ matchCount 0). The
 * result is returned to the client verbatim — never summarized by a model.
 */
export const findPatientsToolSchema = z.object({
  patientId: z
    .string()
    .optional()
    .describe(
      'The patient UUID, if the user gave one, e.g. "9ec974ce-91d6-48e3-a8af-796c05348080".',
    ),
  name: z
    .string()
    .optional()
    .describe(
      "The patient's name (full, or just first or last) if the question is about a SPECIFIC " +
        "patient, e.g. 'Adolfo Ricker'.",
    ),
  conditionQuery: z
    .string()
    .optional()
    .describe(
      "A medical condition/disease/symptom to search ACROSS patients, e.g. 'diabetes', " +
        "'dementia', 'chronic pain'. The clinical concept only — never a name or ID.",
    ),
  allergyQuery: z
    .string()
    .optional()
    .describe(
      "An allergen/substance for an 'allergic to X' search ACROSS patients, e.g. 'penicillin', " +
        "'sulfa'. The substance only — never a name or ID. An allergy is NOT a diagnosis.",
    ),
});

export type FindPatientsToolInput = z.infer<typeof findPatientsToolSchema>;

/**
 * Function input — each field optional and nullable so the structured-output extractor's result
 * (fields are `.nullable()`) can be passed straight in.
 */
export interface FindPatientsInput {
  patientId?: string | null;
  name?: string | null;
  conditionQuery?: string | null;
  allergyQuery?: string | null;
}

// ── Per-record detail types. These mirror the Prisma models 1:1 (minus the internal
//    surrogate `id`/`patientId` join keys) so the client receives the FULL record set:
//    demographics + every condition, medication, allergy and observation. Dates are
//    pre-formatted to strings (date-only for `@db.Date`, ISO for timestamps) so the
//    payload is plain JSON the UI can render without re-parsing Date objects. ──

export interface ConditionDetail {
  clinicalStatus: string | null;
  icd10Code: string | null;
  icd10Description: string | null;
  isPrimaryDiagnosis: boolean | null;
  onsetDate: string | null;
  resolvedDate: string | null;
  createdBy: string | null;
  createdTime: string | null;
  revBy: string | null;
  revTime: string | null;
}

export interface MedicationDetail {
  description: string | null;
  genericName: string | null;
  strength: string | null;
  strengthUnit: string | null;
  directions: string | null;
  status: string | null;
  narcotic: boolean | null;
  rxNormId: string | null;
  startTime: string | null;
  orderTime: string | null;
  createdTime: string | null;
  revTime: string | null;
}

export interface AllergyDetail {
  allergen: string | null;
  category: string | null;
  type: string | null;
  severity: string | null;
  reactionType: string | null;
  reactionSubType: string | null;
  reactionNote: string | null;
  clinicalStatus: string | null;
  onsetDate: string | null;
  resolvedDate: string | null;
  createdBy: string | null;
  createdTime: string | null;
  revBy: string | null;
  revTime: string | null;
}

export interface ObservationDetail {
  method: string | null;
  recordedBy: string | null;
  recordedTime: string | null;
  /** Free-form JSON, e.g. `{ "type": "PainLevel", "value": 0 }`. */
  data: unknown;
}

/** Full detail returned for a single matched patient — demographics + every child record. */
export interface PatientDetail {
  id: string;
  nameFirst: string | null;
  nameLast: string | null;
  dob: string | null;
  gender: string | null;
  ethnicityDescription: string | null;
  legalMailingAddress: unknown;
  status: string | null;
  group: string;
  email: string | null;
  phone: string | null;
  outpatient: boolean | null;
  onLeave: boolean | null;
  // Stay / location
  unitDescription: string | null;
  floorDescription: string | null;
  roomDescription: string | null;
  bedDescription: string | null;
  admissionTime: string | null;
  dischargeTime: string | null;
  deathTime: string | null;
  // Audit
  revBy: string | null;
  revTime: string | null;
  // Child records
  conditions: ConditionDetail[];
  medications: MedicationDetail[];
  allergies: AllergyDetail[];
  observations: ObservationDetail[];
}

/**
 * One patient surfaced by the semantic (attribute) search. Carries the patient's COMPLETE record
 * (so the client can render the full card on tap without a second request) plus what they matched
 * on and how strongly. Either/both of `matchedCondition` / `matchedAllergy` is set per match,
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

/**
 * Unified result of the one retrieval tool. Exactly one array is populated by whichever path ran:
 *   • patients — full records, from the identity lookup (patientId/name).
 *   • matches  — semantic hits + confidence, from the attribute search (condition/allergy).
 * Neither populated ⇒ matchCount 0 (caller emits the safe fallback).
 */
export interface FindPatientsResult {
  query: {
    patientId?: string;
    name?: string;
    conditionQuery?: string;
    allergyQuery?: string;
  };
  matchCount: number;
  patients?: PatientDetail[];
  matches?: ConditionMatch[];
}

// Distinct patients to return on either path.
const MAX_MATCHES = 5;
const OBSERVATION_LIMIT = 50;
// Minimum cosine similarity for an attribute hit to count. Cosine always returns *something*, so
// without a floor we'd surface unrelated rows (and never reach the safe fallback). maxDistance =
// 1 - threshold because pgvector's `<=>` returns cosine DISTANCE (1 - similarity).
const SIMILARITY_THRESHOLD = 0.45;
// Candidate rows to pull per search before de-duping to distinct patients in JS.
const CANDIDATE_LIMIT = 100;

/** Date-only (`YYYY-MM-DD`) for `@db.Date` columns. */
const dateOnly = (d: Date | null): string | null =>
  d ? d.toISOString().slice(0, 10) : null;
/** Full ISO timestamp for `@db.Timestamptz` columns. */
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The full-record `include` shape: every child table, observations capped to the most recent.
 * Shared by both retrieval paths so they return identical patient payloads.
 */
export const patientInclude = {
  conditions: true,
  medications: true,
  allergies: true,
  observations: { orderBy: { recordedTime: 'desc' }, take: OBSERVATION_LIMIT },
} satisfies Prisma.PatientInclude;

type PatientWithRecords = Prisma.PatientGetPayload<{ include: typeof patientInclude }>;

/** Map a fully-included Prisma patient to the flat, JSON-ready `PatientDetail` the UI renders. */
export function toPatientDetail(p: PatientWithRecords): PatientDetail {
  return {
    id: p.id,
    nameFirst: p.nameFirst,
    nameLast: p.nameLast,
    dob: dateOnly(p.dob),
    gender: p.gender,
    ethnicityDescription: p.ethnicityDescription,
    legalMailingAddress: p.legalMailingAddress,
    status: p.status,
    group: p.group,
    email: p.email,
    phone: p.phone,
    outpatient: p.outpatient,
    onLeave: p.onLeave,
    unitDescription: p.unitDescription,
    floorDescription: p.floorDescription,
    roomDescription: p.roomDescription,
    bedDescription: p.bedDescription,
    admissionTime: iso(p.admissionTime),
    dischargeTime: iso(p.dischargeTime),
    deathTime: iso(p.deathTime),
    revBy: p.revBy,
    revTime: iso(p.revTime),
    conditions: p.conditions.map((c) => ({
      clinicalStatus: c.clinicalStatus,
      icd10Code: c.icd10Code,
      icd10Description: c.icd10Description,
      isPrimaryDiagnosis: c.isPrimaryDiagnosis,
      onsetDate: dateOnly(c.onsetDate),
      resolvedDate: dateOnly(c.resolvedDate),
      createdBy: c.createdBy,
      createdTime: iso(c.createdTime),
      revBy: c.revBy,
      revTime: iso(c.revTime),
    })),
    medications: p.medications.map((m) => ({
      description: m.description,
      genericName: m.genericName,
      strength: m.strength,
      strengthUnit: m.strengthUnit,
      directions: m.directions,
      status: m.status,
      narcotic: m.narcotic,
      rxNormId: m.rxNormId,
      startTime: dateOnly(m.startTime),
      orderTime: iso(m.orderTime),
      createdTime: iso(m.createdTime),
      revTime: iso(m.revTime),
    })),
    allergies: p.allergies.map((a) => ({
      allergen: a.allergen,
      category: a.category,
      type: a.type,
      severity: a.severity,
      reactionType: a.reactionType,
      reactionSubType: a.reactionSubType,
      reactionNote: a.reactionNote,
      clinicalStatus: a.clinicalStatus,
      onsetDate: dateOnly(a.onsetDate),
      resolvedDate: dateOnly(a.resolvedDate),
      createdBy: a.createdBy,
      createdTime: iso(a.createdTime),
      revBy: a.revBy,
      revTime: iso(a.revTime),
    })),
    observations: p.observations.map((o) => ({
      method: o.method,
      recordedBy: o.recordedBy,
      recordedTime: iso(o.recordedTime),
      data: o.data,
    })),
  };
}

/**
 * Build the Prisma `where` for an identity lookup, precision-first:
 *   1. ID present  -> exact match on `patient.id` (authoritative; short-circuits).
 *   2. else name   -> split into whitespace tokens; every token must appear (case-insensitively)
 *                     in the first OR last name, so 'Adolfo Ricker' matches first='Adolfo'
 *                     last='Ricker' and a single token matches either.
 *   3. neither     -> null: no criteria, so we skip the DB (never list all patients).
 *
 * Cohort scoping is intentionally not applied yet — the search spans every patient.
 */
function buildWhere(patientId?: string, name?: string) {
  if (patientId) return { id: patientId };

  const tokens = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (tokens.length) {
    return {
      AND: tokens.map((token) => ({
        OR: [
          { nameFirst: { contains: token, mode: 'insensitive' as const } },
          { nameLast: { contains: token, mode: 'insensitive' as const } },
        ],
      })),
    };
  }

  return null;
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

function toConfidence(similarity: number): ConditionMatch['confidence'] {
  if (similarity >= 0.6) return 'High';
  if (similarity >= 0.5) return 'Medium';
  return 'Low';
}

/** Identity path: resolve by id/name, return full records. */
async function findByIdentity(
  prisma: PrismaService,
  patientId?: string,
  name?: string,
): Promise<PatientDetail[]> {
  const where = buildWhere(patientId, name);
  if (!where) return [];
  const patients = await prisma.patient.findMany({
    where,
    take: MAX_MATCHES,
    orderBy: [{ nameLast: 'asc' }, { nameFirst: 'asc' }],
    include: patientInclude,
  });
  return patients.map(toPatientDetail);
}

/**
 * Attribute path: semantic search by condition and/or allergy.
 *
 * Flow: embed the query → cosine-rank it against the matching vocabulary (the `embedding`
 * pgvector column on `icd_code` for conditions, on `allergen` for allergies) → keep the best
 * match per patient → fetch those patients' FULL records in one query. When BOTH a condition and
 * an allergy are given, a patient surfaced by both carries both hits; ranking uses the strongest.
 *
 * Cohort scoping is intentionally NOT applied; the SQL marks the predicate that re-enables it.
 */
async function findByAttribute(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
  conditionQuery?: string,
  allergyQuery?: string,
): Promise<ConditionMatch[]> {
  const maxDistance = 1 - SIMILARITY_THRESHOLD;
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
      -- Cohort scoping intentionally OFF. To re-enable, add:  AND p."group" = <activeCohort>
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
      -- Cohort scoping intentionally OFF. To re-enable, add:  AND p."group" = <activeCohort>
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
  if (ranked.length === 0) return [];

  // Fetch the full records for the ranked patients in one query, then assemble in similarity order.
  const patients = await prisma.patient.findMany({
    where: { id: { in: ranked.map((r) => r.patientId) } },
    include: patientInclude,
  });
  const byId = new Map(patients.map((p) => [p.id, toPatientDetail(p)]));

  return ranked
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
}

/**
 * THE unified patient-finder. Routes internally (identity wins): a patientId/name resolves a
 * specific patient (full records), otherwise a condition/allergy runs the semantic search
 * (ranked matches). Plain async fn so `QaService` calls it directly after extraction; also wrapped
 * as the single LangChain tool below.
 */
export async function findPatients(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
  input: FindPatientsInput,
): Promise<FindPatientsResult> {
  const patientId = input.patientId?.trim() || undefined;
  const name = input.name?.trim() || undefined;
  const conditionQuery = input.conditionQuery?.trim() || undefined;
  const allergyQuery = input.allergyQuery?.trim() || undefined;
  const query = { patientId, name, conditionQuery, allergyQuery };

  // Identity wins: a specific patient beats a co-mentioned condition/allergy.
  if (patientId || name) {
    const patients = await findByIdentity(prisma, patientId, name);
    return { query, matchCount: patients.length, patients };
  }

  if (conditionQuery || allergyQuery) {
    const matches = await findByAttribute(
      prisma,
      embeddings,
      conditionQuery,
      allergyQuery,
    );
    return { query, matchCount: matches.length, matches };
  }

  return { query, matchCount: 0 };
}

/**
 * Factory: wraps {@link findPatients} as the single LangChain tool (retained so `langgraphjs dev`
 * studio works); the HTTP path calls `findPatients` directly after the extraction step.
 */
export function createFindPatientsTool(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
) {
  return tool(
    (input: FindPatientsToolInput): Promise<FindPatientsResult> =>
      findPatients(prisma, embeddings, input),
    {
      name: 'find_patients',
      description: `Find patient(s). ONE tool for both lookups — set whichever field(s) apply:
                    • patientId / name → resolve a SPECIFIC patient (returns full records).
                    • conditionQuery → patients with a disease/symptom ("who has diabetes?").
                    • allergyQuery → patients allergic to a substance ("allergic to penicillin");
                      an allergy is NOT a diagnosis. Combine with conditionQuery for both.
                    Identity (id/name) takes priority over condition/allergy. Pass the clinical
                    concept / substance ONLY in the query fields — never a name or ID there.
                    Returns matchCount 0 when nothing resolves/matches.`,
      schema: findPatientsToolSchema,
    },
  );
}
