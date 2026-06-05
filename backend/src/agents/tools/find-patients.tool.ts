import { tool } from 'langchain';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { EmbeddingsService } from '../../embeddings/embeddings.service';
import { toVectorLiteral } from '../../embeddings/embeddings.factory';
import type { CohortGroup } from '../../auth/cohort.types';

/**
 * Observation measurements live in `patient_observation.data` (JSONB) as
 * `{ "type": <metric>, "unit": <unit>, "value": <n> }` — except BloodPressure, which carries
 * `systolicValue`/`diastolicValue` instead of a single `value`. This map is the SINGLE SOURCE OF
 * TRUTH for each metric's JSON value key(s) and canonical unit; it drives both the SQL builder and
 * the human-readable summary. Units are fixed per metric (the dataset never varies them), so a
 * measurement filter just compares the raw number against the metric's native unit.
 */
export const OBSERVATION_METRICS = {
  PainLevel: { unit: null, keys: ['value'] },
  Weight: { unit: 'Lbs', keys: ['value'] },
  Height: { unit: 'Inches', keys: ['value'] },
  BloodPressure: { unit: 'mmHg', keys: ['systolicValue', 'diastolicValue'] },
  BloodSugar: { unit: 'mg/dL', keys: ['value'] },
  HeartRate: { unit: 'bpm', keys: ['value'] },
  Temperature: { unit: '°F', keys: ['value'] },
  RespiratoryRate: { unit: 'Breaths/min', keys: ['value'] },
  OxygenSaturation: { unit: '%', keys: ['value'] },
} as const satisfies Record<string, { unit: string | null; keys: readonly string[] }>;

export type ObservationMetric = keyof typeof OBSERVATION_METRICS;

const OBSERVATION_METRIC_NAMES = Object.keys(OBSERVATION_METRICS) as [
  ObservationMetric,
  ...ObservationMetric[],
];

/** Which reading of a two-field BloodPressure measurement to compare. */
export const BLOOD_PRESSURE_COMPONENTS = ['systolic', 'diastolic'] as const;
export type BloodPressureComponent = (typeof BLOOD_PRESSURE_COMPONENTS)[number];

/**
 * Structured numeric filter over ONE observation metric, e.g. "weight over 200 lbs" ⇒
 * `{ metric: 'Weight', operator: 'gt', value: 200 }`. `value2` is the upper bound for `between`;
 * `component` selects systolic/diastolic for BloodPressure (ignored for single-value metrics).
 * Shared so the extractor (`.nullable()`) and the tool schema (`.optional()`) stay in lockstep.
 */
export const observationFilterSchema = z.object({
  metric: z.enum(OBSERVATION_METRIC_NAMES),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'between']),
  value: z.number(),
  value2: z.number().nullable(),
  component: z.enum(BLOOD_PRESSURE_COMPONENTS).nullable(),
});

export type ObservationFilter = z.infer<typeof observationFilterSchema>;

/**
 * Structured filter for a "which patients TAKE drug X" search, optionally narrowed by dose, form
 * and route. There is no medication vocabulary table or embeddings: a prescription's full text
 * (`patient_medication.description`, e.g. "Acetaminophen 325 MG Oral Tablet Tylenol") already
 * concatenates name + dose + release + route + form + brand, so every attribute is matched as a
 * co-located substring of that one column (plus `generic_name` for the name). The synonym work —
 * brand↔generic ("Tylenol"↔"acetaminophen"), phrasing ("by mouth"→Oral, "pill"→Tablet) — is done
 * by the extractor LLM (already in the pipeline), so retrieval stays deterministic exact ILIKE.
 * Shared so the extractor (`.nullable()`) and the tool schema (`.optional()`) stay in lockstep.
 */
export const medicationFilterSchema = z.object({
  names: z
    .array(z.string())
    .describe(
      'The drug the patient takes, PLUS its brand/generic synonyms for the SAME drug ' +
        '("Tylenol" => ["Tylenol","acetaminophen"]; "Lasix" => ["Lasix","furosemide"]). These are ' +
        'OR-matched, so include every common name of the one drug. NEVER a therapeutic class — ' +
        'for "painkillers"/"antibiotics"/"blood thinners" leave medicationFilter null. At least one term.',
    ),
  doseText: z
    .string()
    .nullable()
    .describe(
      'The dose EXACTLY as printed on a label: number, a space, then the uppercase unit, e.g. ' +
        '"325 MG", "0.05 MG", "10 MEQ", "50 MCG". Convert the user\'s wording ("325 milligrams" => ' +
        '"325 MG", "half a gram" => "500 MG"). Null when no dose is specified.',
    ),
  form: z
    .string()
    .nullable()
    .describe(
      'Dosage form, EXACTLY one of: Tablet, Capsule, Solution, Suspension, Suppository, Cream, ' +
        'Ointment, Gel, Lotion, Spray, Inhaler. Map synonyms ("pill"/"tab" => Tablet). Null when ' +
        'the form is not specified.',
    ),
  route: z
    .string()
    .nullable()
    .describe(
      'Route of administration, EXACTLY one of: Oral, Injection, Ophthalmic, Topical, Rectal, ' +
        'Inhalation, Transdermal, Nasal. Map synonyms ("by mouth" => Oral, "shot"/"IV" => ' +
        'Injection, "eye" => Ophthalmic, "patch" => Transdermal). Null when not specified.',
    ),
});

export type MedicationFilter = z.infer<typeof medicationFilterSchema>;

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
  observationFilter: observationFilterSchema
    .optional()
    .describe(
      "A numeric filter over a vital-sign/measurement ACROSS patients, e.g. 'weight over 200 " +
        "lbs' ⇒ { metric: 'Weight', operator: 'gt', value: 200 }. Combine with conditionQuery/" +
        "allergyQuery to intersect ('diabetics with heart rate over 100').",
    ),
  medicationFilter: medicationFilterSchema
    .optional()
    .describe(
      "Patients TAKING a drug ACROSS the cohort, optionally narrowed by dose/form/route " +
        "('who is on Tylenol?' ⇒ { names: ['Tylenol','acetaminophen'] }; 'injectable insulin' ⇒ " +
        "{ names: ['insulin'], route: 'Injection' }). Combine with condition/allergy/observation " +
        "to intersect ('diabetics on metformin').",
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
  observationFilter?: ObservationFilter | null;
  medicationFilter?: MedicationFilter | null;
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
  group: CohortGroup;
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
  /**
   * The reading that satisfied an observation filter (set for measurement searches). Deterministic
   * — the patient's value either passes the numeric predicate or it doesn't.
   */
  matchedObservation?: {
    metric: ObservationMetric;
    /** Which value was compared for BloodPressure; undefined for single-value metrics. */
    component?: BloodPressureComponent;
    value: number;
    unit: string | null;
    recordedTime: string | null;
  };
  /**
   * The prescription that satisfied a medication filter (set for medication searches).
   * Deterministic — the prescription text either contains the search terms or it doesn't.
   * `description` is the primary citation (what they take); `directions` answers "how often".
   */
  matchedMedication?: {
    description: string | null;
    genericName: string | null;
    strength: string | null;
    strengthUnit: string | null;
    directions: string | null;
    narcotic: boolean | null;
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
    /** Human-readable measurement filter, e.g. "Weight > 200 Lbs". */
    observation?: string;
    /** Human-readable medication filter, e.g. "Tylenol/acetaminophen, 325 MG, Oral Tablet". */
    medication?: string;
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
    // Prisma types the column as `string`; the data only ever holds 'A'/'B' and retrieval is
    // already scoped by a validated CohortGroup, so narrow it at this boundary.
    group: p.group as CohortGroup,
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
 * Cohort scoping is ALWAYS applied: `group` is ANDed into every branch, so even an exact id match
 * resolves nothing when that patient belongs to the other cohort.
 */
function buildWhere(group: CohortGroup, patientId?: string, name?: string) {
  if (patientId) return { id: patientId, group };

  const tokens = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (tokens.length) {
    return {
      group,
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
 * Per-patient accumulator: a patient's best condition hit and/or best allergy hit, plus the
 * observation reading that passed a measurement filter. A patient surfaced by several searches
 * carries all of them, so one match can report a condition AND an allergy AND a measurement.
 */
interface Candidate {
  patientId: string;
  matchedCondition?: ConditionMatch['matchedCondition'];
  matchedAllergy?: ConditionMatch['matchedAllergy'];
  matchedObservation?: ConditionMatch['matchedObservation'];
  matchedMedication?: ConditionMatch['matchedMedication'];
}

function toConfidence(similarity: number): ConditionMatch['confidence'] {
  if (similarity >= 0.6) return 'High';
  if (similarity >= 0.5) return 'Medium';
  return 'Low';
}

/** Raw row from the observation filter query (one per matching patient, latest reading). */
interface ObservationRankRow {
  patientId: string;
  value: number | string | null;
  recordedTime: Date | string | null;
}

/** Operator → symbol, for the human-readable measurement summary. */
const OBSERVATION_OP_SYMBOL: Record<ObservationFilter['operator'], string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  between: 'between',
};

/**
 * Map the WHITELISTED operator enum to a constant SQL comparison fragment. The operator is the only
 * structural SQL token; it can only ever be one of these six literals (it comes from a Zod enum),
 * so no user text reaches the query as SQL. `valueExpr` is a parameterized JSON-extraction
 * fragment and the bounds are bound parameters.
 */
function observationPredicate(
  valueExpr: Prisma.Sql,
  operator: ObservationFilter['operator'],
  value: number,
  value2: number | null,
): Prisma.Sql {
  switch (operator) {
    case 'gt':
      return Prisma.sql`${valueExpr} > ${value}`;
    case 'gte':
      return Prisma.sql`${valueExpr} >= ${value}`;
    case 'lt':
      return Prisma.sql`${valueExpr} < ${value}`;
    case 'lte':
      return Prisma.sql`${valueExpr} <= ${value}`;
    case 'eq':
      return Prisma.sql`${valueExpr} = ${value}`;
    case 'between': {
      // Missing upper bound degrades to equality rather than erroring; order the bounds so a
      // reversed range ("between 200 and 100") still works.
      const hi = value2 ?? value;
      return Prisma.sql`${valueExpr} BETWEEN ${Math.min(value, hi)} AND ${Math.max(value, hi)}`;
    }
  }
}

/** Build a human-readable summary of a measurement filter, e.g. "Weight > 200 Lbs". */
function describeObservation(f: ObservationFilter): string {
  const def = OBSERVATION_METRICS[f.metric];
  const unit = def.unit ? ` ${def.unit}` : '';
  const component = def.keys.length > 1 ? ` (${f.component ?? 'systolic'})` : '';
  if (f.operator === 'between') {
    return `${f.metric}${component} between ${f.value} and ${f.value2 ?? f.value}${unit}`;
  }
  return `${f.metric}${component} ${OBSERVATION_OP_SYMBOL[f.operator]} ${f.value}${unit}`;
}

/**
 * Observation (measurement) filter: numeric predicate over the JSONB `data` column. Unlike the
 * condition/allergy paths this is DETERMINISTIC — a patient's reading either passes or it doesn't,
 * no embeddings. Returns one entry per matching patient (their latest matching reading).
 *
 * Cohort scoping is enforced in the SQL itself (`AND p."group" = ${group}`), identical to the
 * similarity queries. Injection-safe: the metric, the JSON value-key and the unit key are bound
 * PARAMETERS; the operator is a whitelisted constant fragment; only numeric bounds are user data.
 */
async function findObservationMatches(
  prisma: PrismaService,
  group: CohortGroup,
  filter: ObservationFilter,
): Promise<Map<string, NonNullable<ConditionMatch['matchedObservation']>>> {
  const def = OBSERVATION_METRICS[filter.metric];
  // BloodPressure has systolic/diastolic; single-value metrics ignore `component`.
  const component: BloodPressureComponent | undefined =
    def.keys.length > 1
      ? filter.component === 'diastolic'
        ? 'diastolic'
        : 'systolic'
      : undefined;
  const jsonKey = component === 'diastolic' ? def.keys[1] : def.keys[0];

  const valueExpr = Prisma.sql`(o.data->>${jsonKey})::numeric`;
  const predicate = observationPredicate(
    valueExpr,
    filter.operator,
    filter.value,
    filter.value2,
  );

  // DISTINCT ON keeps each patient's latest matching reading (recorded_time DESC). For this
  // dataset there is exactly one reading per (patient, metric), so this is also "any/highest".
  const rows = await prisma.$queryRaw<ObservationRankRow[]>`
    SELECT DISTINCT ON (p.id)
      p.id            AS "patientId",
      ${valueExpr}    AS "value",
      o.recorded_time AS "recordedTime"
    FROM patient_observation o
    JOIN patient p ON p.id = o.patient_id
    WHERE p."group" = ${group}
      AND o.data->>'type' = ${filter.metric}
      AND ${predicate}
    ORDER BY p.id, o.recorded_time DESC NULLS LAST
  `;

  const out = new Map<string, NonNullable<ConditionMatch['matchedObservation']>>();
  for (const r of rows) {
    out.set(r.patientId, {
      metric: filter.metric,
      component,
      value: Number(r.value),
      unit: def.unit,
      recordedTime: r.recordedTime ? new Date(r.recordedTime).toISOString() : null,
    });
  }
  return out;
}

/** Raw row from the medication filter query (one representative prescription per matching patient). */
interface MedicationRankRow {
  patientId: string;
  description: string | null;
  genericName: string | null;
  strength: string | null;
  strengthUnit: string | null;
  directions: string | null;
  narcotic: boolean | null;
}

/** Build a human-readable summary of a medication filter, e.g. "Tylenol/acetaminophen, 325 MG, Oral Tablet". */
function describeMedication(f: MedicationFilter): string {
  return [f.names.join('/'), f.doseText, f.route, f.form].filter(Boolean).join(', ');
}

/**
 * Canonical route/form value → the substring STEM that actually appears in `description`. The
 * extractor emits a clean canonical token ("Injection", "Inhalation"), but the prescription text
 * uses inflected forms ("Injectable Solution", "Pen Injector"; "Inhalation"/"Inhaler"). Matching the
 * stem (`Inject`, `Inhal`, `Suppositor`) catches every inflection without over-narrowing. Unknown
 * tokens (the field is a free string, not a hard enum) fall back to matching the token verbatim.
 */
const ROUTE_MATCH: Record<string, string> = {
  Oral: 'Oral',
  Injection: 'Inject',
  Ophthalmic: 'Ophthalmic',
  Topical: 'Topical',
  Rectal: 'Rectal',
  Inhalation: 'Inhal',
  Transdermal: 'Transdermal',
  Nasal: 'Nasal',
};
const FORM_MATCH: Record<string, string> = {
  Tablet: 'Tablet',
  Capsule: 'Capsule',
  Solution: 'Solution',
  Suspension: 'Suspension',
  Suppository: 'Suppositor',
  Cream: 'Cream',
  Ointment: 'Ointment',
  Gel: 'Gel',
  Lotion: 'Lotion',
  Spray: 'Spray',
  Inhaler: 'Inhal',
};

/**
 * Medication search: DETERMINISTIC "which patients take drug X" lookup, optionally narrowed by
 * dose/form/route. No embeddings/vocabulary — the prescription's `description` already concatenates
 * name + dose + release + route + form + brand, so we AND substring (ILIKE) matches against that
 * single column: an OR-group over the name synonyms (also checking `generic_name`), then one
 * mandatory ILIKE per supplied dose/form/route token. Returns one entry per matching patient
 * (their most recently ordered matching prescription).
 *
 * Cohort scoping is enforced in the SQL (`AND p."group" = ${group}`) via the patient join —
 * `patient_medication` has no group column, so this join is the ONLY path to the cohort boundary.
 * Injection-safe: every search term is a bound parameter (wrapped in `%…%` in JS, never
 * interpolated as SQL); there are no structural tokens taken from user text.
 */
async function findMedicationMatches(
  prisma: PrismaService,
  group: CohortGroup,
  filter: MedicationFilter,
): Promise<Map<string, NonNullable<ConditionMatch['matchedMedication']>>> {
  // Name OR-group: any synonym may match the full description OR the (sometimes null) generic name.
  const nameOr = Prisma.join(
    filter.names.map(
      (n) =>
        Prisma.sql`(m.description ILIKE ${'%' + n + '%'} OR m.generic_name ILIKE ${'%' + n + '%'})`,
    ),
    ' OR ',
  );
  // Each supplied attribute is an additional constraint that must appear in the description (AND).
  // Route/form are matched by their description STEM (Injection→"Inject", Inhalation→"Inhal", …) so
  // inflected wording ("Injectable Solution") still matches; unknown tokens match verbatim.
  const conds: Prisma.Sql[] = [Prisma.sql`(${nameOr})`];
  if (filter.doseText)
    conds.push(Prisma.sql`m.description ILIKE ${'%' + filter.doseText + '%'}`);
  if (filter.form) {
    const formToken = FORM_MATCH[filter.form] ?? filter.form;
    conds.push(Prisma.sql`m.description ILIKE ${'%' + formToken + '%'}`);
  }
  if (filter.route) {
    const routeToken = ROUTE_MATCH[filter.route] ?? filter.route;
    conds.push(Prisma.sql`m.description ILIKE ${'%' + routeToken + '%'}`);
  }
  const predicate = Prisma.join(conds, ' AND ');

  const rows = await prisma.$queryRaw<MedicationRankRow[]>`
    SELECT DISTINCT ON (p.id)
      p.id           AS "patientId",
      m.description  AS "description",
      m.generic_name AS "genericName",
      m.strength     AS "strength",
      m.strength_unit AS "strengthUnit",
      m.directions   AS "directions",
      m.narcotic     AS "narcotic"
    FROM patient_medication m
    JOIN patient p ON p.id = m.patient_id
    WHERE p."group" = ${group}
      AND (${predicate})
    ORDER BY p.id, m.order_time DESC NULLS LAST
  `;

  const out = new Map<string, NonNullable<ConditionMatch['matchedMedication']>>();
  for (const r of rows) {
    out.set(r.patientId, {
      description: r.description,
      genericName: r.genericName,
      strength: r.strength,
      strengthUnit: r.strengthUnit,
      directions: r.directions,
      narcotic: r.narcotic,
    });
  }
  return out;
}

/** Identity path: resolve by id/name within the active cohort, return full records. */
async function findByIdentity(
  prisma: PrismaService,
  group: CohortGroup,
  patientId?: string,
  name?: string,
): Promise<PatientDetail[]> {
  const where = buildWhere(group, patientId, name);
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
 * Attribute path: search ACROSS patients by condition, allergy, a measurement filter, and/or a
 * medication filter, in any combination.
 *
 * Two kinds of constraint:
 *   • FUZZY (condition, allergy): embed the query → cosine-rank against the vocabulary (the
 *     `embedding` pgvector column on `icd_code` / `allergen`) → keep the best per patient. These
 *     UNION (a patient surfaced by either appears).
 *   • DETERMINISTIC (medication, observation): a patient's records either satisfy the predicate or
 *     not (no embeddings).
 *
 * Combination rule (`applyDeterministic`): a deterministic filter INTERSECTS when any prior
 * constraint was REQUESTED (so "diabetics on metformin" keeps only patients matching both), and
 * SEEDS the candidate set when it is the first constraint (so "who's on Tylenol?" returns every
 * patient on the drug). Intersection is commutative, so medication/observation order is irrelevant.
 * Finally the surviving patients' FULL records are fetched in one query.
 *
 * Cohort scoping is enforced in every SQL statement (`AND p."group" = ${group}`), so no path can
 * surface a patient outside the active cohort.
 */
async function findByAttribute(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
  group: CohortGroup,
  conditionQuery?: string,
  allergyQuery?: string,
  observationFilter?: ObservationFilter | null,
  medicationFilter?: MedicationFilter | null,
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
        AND p."group" = ${group}
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
        AND p."group" = ${group}
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

  // `hasCandidates` tracks whether any constraint has been REQUESTED so far — seeded from whether a
  // fuzzy search ran, NOT from byPatient.size. This matters when a fuzzy search matched nothing:
  // "diabetics on metformin" with zero diabetes hits must intersect an EMPTY set (→ no results),
  // not let medication seed and return every metformin patient.
  let hasCandidates = Boolean(conditionQuery || allergyQuery);

  /**
   * Fold one deterministic filter's hits into `byPatient`: INTERSECT when a prior constraint was
   * requested (keep only existing candidates that also pass, annotating them), else SEED (each
   * passing patient becomes a candidate). Any requested deterministic filter then forces later ones
   * to intersect, so the filters compose as a logical AND regardless of order.
   */
  const applyDeterministic = <T>(
    hits: Map<string, T>,
    assign: (c: Candidate, hit: T) => void,
  ): void => {
    if (hasCandidates) {
      for (const [patientId, c] of byPatient) {
        const hit = hits.get(patientId);
        if (hit) assign(c, hit);
        else byPatient.delete(patientId);
      }
    } else {
      for (const [patientId, hit] of hits) assign(upsert(patientId), hit);
    }
    hasCandidates = true;
  };

  // ── Medication filter: deterministic substring (ILIKE) match over the prescription text. ──
  if (medicationFilter) {
    const meds = await findMedicationMatches(prisma, group, medicationFilter);
    applyDeterministic(meds, (c, hit) => {
      c.matchedMedication = hit;
    });
  }

  // ── Observation filter: deterministic numeric predicate over the JSONB `data` column. ──
  if (observationFilter) {
    const obs = await findObservationMatches(prisma, group, observationFilter);
    applyDeterministic(obs, (c, hit) => {
      c.matchedObservation = hit;
    });
  }

  const bestSimilarity = (c: Candidate): number =>
    Math.max(
      c.matchedCondition?.similarity ?? -1,
      c.matchedAllergy?.similarity ?? -1,
    );

  // Rank by the explicit numeric criterion when a measurement filter ran (most-extreme reading
  // first; ascending for </<=), otherwise by the strongest similarity hit. A deterministic-only
  // match (e.g. medication-only) has no similarity, so candidates tie at -1 and fall through to a
  // stable id tie-break for reproducible ordering. Capped at MAX_MATCHES.
  const ascending =
    observationFilter?.operator === 'lt' || observationFilter?.operator === 'lte';
  const ranked = [...byPatient.values()]
    .sort((a, b) => {
      if (observationFilter) {
        const va = a.matchedObservation?.value ?? Number.NEGATIVE_INFINITY;
        const vb = b.matchedObservation?.value ?? Number.NEGATIVE_INFINITY;
        if (va !== vb) return ascending ? va - vb : vb - va;
        return a.patientId < b.patientId ? -1 : a.patientId > b.patientId ? 1 : 0;
      }
      const bySim = bestSimilarity(b) - bestSimilarity(a);
      if (bySim !== 0) return bySim;
      return a.patientId < b.patientId ? -1 : a.patientId > b.patientId ? 1 : 0;
    })
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
      const matchedObservation = c.matchedObservation
        ? {
            ...c.matchedObservation,
            value: Number(c.matchedObservation.value.toFixed(2)),
          }
        : undefined;
      // A pure deterministic match (measurement and/or medication) is a definite pass ⇒ High; when
      // a fuzzy condition/allergy is also present, confidence reflects that (the only uncertain part).
      const confidence =
        c.matchedCondition || c.matchedAllergy
          ? toConfidence(bestSimilarity(c))
          : ('High' as const);
      return {
        patient,
        matchedCondition,
        matchedAllergy,
        matchedObservation,
        matchedMedication: c.matchedMedication,
        confidence,
      };
    })
    .filter((m): m is ConditionMatch => m !== null);
}

/**
 * THE unified patient-finder. Routes internally (identity wins): a patientId/name resolves a
 * specific patient (full records), otherwise a condition/allergy runs the semantic search
 * (ranked matches). Plain async fn so `QaService` calls it directly after extraction; also wrapped
 * as the single LangChain tool below.
 *
 * `group` is mandatory and threaded into EVERY query path — there is intentionally no way to call
 * this unscoped, which is what keeps the cohort boundary an enforced invariant rather than a
 * convention the caller has to remember.
 */
export async function findPatients(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
  input: FindPatientsInput,
  group: CohortGroup,
): Promise<FindPatientsResult> {
  const patientId = input.patientId?.trim() || undefined;
  const name = input.name?.trim() || undefined;
  const conditionQuery = input.conditionQuery?.trim() || undefined;
  const allergyQuery = input.allergyQuery?.trim() || undefined;
  const observationFilter = input.observationFilter ?? undefined;
  // Normalize the medication filter: trim/drop blank name terms; with no usable name the filter is
  // absent (a dose/form/route alone is never a standalone medication search).
  const medNames =
    input.medicationFilter?.names?.map((n) => n.trim()).filter(Boolean) ?? [];
  const medicationFilter: MedicationFilter | undefined = medNames.length
    ? { ...input.medicationFilter!, names: medNames }
    : undefined;
  const query = {
    patientId,
    name,
    conditionQuery,
    allergyQuery,
    observation: observationFilter ? describeObservation(observationFilter) : undefined,
    medication: medicationFilter ? describeMedication(medicationFilter) : undefined,
  };

  // Identity wins: a specific patient beats a co-mentioned condition/allergy/measurement/medication.
  if (patientId || name) {
    const patients = await findByIdentity(prisma, group, patientId, name);
    return { query, matchCount: patients.length, patients };
  }

  if (conditionQuery || allergyQuery || observationFilter || medicationFilter) {
    const matches = await findByAttribute(
      prisma,
      embeddings,
      group,
      conditionQuery,
      allergyQuery,
      observationFilter,
      medicationFilter,
    );
    return { query, matchCount: matches.length, matches };
  }

  return { query, matchCount: 0 };
}

/**
 * Factory: wraps {@link findPatients} as the single LangChain tool (retained so `langgraphjs dev`
 * studio works); the HTTP path calls `findPatients` directly after the extraction step. Studio
 * runs outside the auth flow, so the cohort is bound here at creation time (the caller pins one).
 */
export function createFindPatientsTool(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
  group: CohortGroup,
) {
  return tool(
    (input: FindPatientsToolInput): Promise<FindPatientsResult> =>
      findPatients(prisma, embeddings, input, group),
    {
      name: 'find_patients',
      description: `Find patient(s). ONE tool for every lookup — set whichever field(s) apply:
                    • patientId / name → resolve a SPECIFIC patient (returns full records).
                    • conditionQuery → patients with a disease/symptom ("who has diabetes?").
                    • allergyQuery → patients allergic to a substance ("allergic to penicillin");
                      an allergy is NOT a diagnosis. Combine with conditionQuery for both.
                    • observationFilter → patients whose vital/measurement passes a numeric test
                      ("weight over 200 lbs"). Combine with condition/allergy to intersect.
                    • medicationFilter → patients TAKING a drug, optionally narrowed by dose/form/
                      route ("who is on Tylenol?", "injectable insulin"). Combine to intersect
                      ("diabetics on metformin").
                    Identity (id/name) takes priority over the across-patient searches. Pass the
                    clinical concept / substance ONLY in the query fields — never a name or ID
                    there. Returns matchCount 0 when nothing resolves/matches.`,
      schema: findPatientsToolSchema,
    },
  );
}
