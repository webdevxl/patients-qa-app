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
// Minimum cosine similarity for an attribute (condition/allergy) concept to count. Cosine always
// returns *something*, so without a floor we'd surface unrelated concepts (and never reach the safe
// fallback). Applied to the ≤CONCEPT_LIMIT vocabulary rows returned by the Stage-1 top-K.
const SIMILARITY_THRESHOLD = 0.45;
// Distinct vocabulary concepts to resolve per fuzzy field (Stage 1) before the cohort-scoped patient
// lookup (Stage 2). Caps the inline VALUES size; the closest concepts dominate, so this is ample.
const CONCEPT_LIMIT = 50;

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

/** A resolved ICD diagnosis concept from Stage 1 (vocabulary top-K): the code + how close to the query. */
interface ConditionConcept {
  code: string;
  description: string;
  similarity: number;
}

/** A resolved allergen concept from Stage 1 (canonical allergen vocabulary top-K). */
interface AllergenConcept {
  id: string;
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

/**
 * One row from the single Stage-2 patient query. Columns exist only for the constraints that actually
 * ran (a medication-only query has no `obs*`/`cond*`/`alg*` columns, etc.), so all but `patientId`
 * are optional.
 */
interface PatientRow {
  patientId: string;
  condCode?: string | null;
  condSim?: number | string | null;
  algId?: string | null;
  algSim?: number | string | null;
  medDescription?: string | null;
  medGenericName?: string | null;
  medStrength?: string | null;
  medStrengthUnit?: string | null;
  medDirections?: string | null;
  medNarcotic?: boolean | null;
  obsValue?: number | string | null;
  obsRecordedTime?: Date | string | null;
}

/**
 * One AND-ed constraint contributing to the single Stage-2 patient query. Each is an inner `LATERAL`
 * that BOTH filters (a patient with no matching row is dropped — this is the AND) and surfaces the
 * matched record; `selectColumns` reads it back and `annotate` attaches it to the candidate. The
 * DB-side ranking is fed by `orderBy` (observation, by measured value) or `similarityCol`
 * (condition/allergy, by cosine similarity), so the final `LIMIT` keeps the right rows.
 */
interface PatientConstraint {
  selectColumns: Prisma.Sql;
  lateralJoin: Prisma.Sql;
  annotate: (candidate: Candidate, row: PatientRow) => void;
  orderBy?: Prisma.Sql;
  similarityCol?: Prisma.Sql;
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
 * Build the observation (measurement) constraint for the Stage-2 query: an inner `LATERAL` that
 * keeps only patients whose latest matching reading satisfies a numeric predicate over the JSONB
 * `data` column, and surfaces that value (which also drives the query's ORDER BY). Deterministic — a
 * reading either passes or it doesn't. Injection-safe: the metric and JSON value-key are bound
 * params, the operator is a whitelisted constant fragment, only numeric bounds are user data, and
 * the ORDER BY direction is a whitelisted ASC/DESC fragment.
 */
function buildObservationConstraint(filter: ObservationFilter): PatientConstraint {
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
  // Most-extreme first: smallest for </<= (we want the lowest passing value), largest otherwise.
  const ascending = filter.operator === 'lt' || filter.operator === 'lte';
  const direction = ascending ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  return {
    selectColumns: Prisma.sql`obs.value AS "obsValue", obs.recorded_time AS "obsRecordedTime"`,
    // Inner LATERAL: a patient with no matching reading is dropped (the AND filter); the latest
    // matching reading (recorded_time DESC) supplies the value for ranking and the citation.
    lateralJoin: Prisma.sql`
      JOIN LATERAL (
        SELECT ${valueExpr} AS value, o.recorded_time
        FROM patient_observation o
        WHERE o.patient_id = p.id
          AND o.data->>'type' = ${filter.metric}
          AND ${predicate}
        ORDER BY o.recorded_time DESC NULLS LAST
        LIMIT 1
      ) obs ON true`,
    orderBy: Prisma.sql`obs.value ${direction}`,
    annotate: (candidate, row) => {
      candidate.matchedObservation = {
        metric: filter.metric,
        component,
        value: Number(row.obsValue),
        unit: def.unit,
        recordedTime: row.obsRecordedTime
          ? new Date(row.obsRecordedTime).toISOString()
          : null,
      };
    },
  };
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
 * Build the medication constraint for the Stage-2 query: an inner `LATERAL` that keeps only patients
 * taking a matching drug and surfaces their most-recently-ordered matching prescription for the
 * citation. No embeddings/vocabulary — the prescription's `description` already concatenates name +
 * dose + release + route + form + brand, so the predicate is an OR-group over the name synonyms
 * (against `description` and the sometimes-null `generic_name`) ANDed with one ILIKE per supplied
 * dose/form/route token; route and form match by description STEM (Injection→"Inject", …) so
 * inflected wording still matches.
 *
 * Cohort scoping is enforced by the outer query's `p."group"` (the lateral reaches
 * `patient_medication` only through `p`). Injection-safe: every search term is a bound `%…%` param —
 * no structural token comes from user text.
 */
function buildMedicationConstraint(filter: MedicationFilter): PatientConstraint {
  // Name OR-group: any synonym may match the full description OR the (sometimes null) generic name.
  const nameOr = Prisma.join(
    filter.names.map(
      (name) =>
        Prisma.sql`(m.description ILIKE ${'%' + name + '%'} OR m.generic_name ILIKE ${'%' + name + '%'})`,
    ),
    ' OR ',
  );
  // Each supplied attribute is an additional ILIKE that must appear in the description (AND).
  const predicates: Prisma.Sql[] = [Prisma.sql`(${nameOr})`];
  if (filter.doseText)
    predicates.push(Prisma.sql`m.description ILIKE ${'%' + filter.doseText + '%'}`);
  if (filter.form) {
    const formToken = FORM_MATCH[filter.form] ?? filter.form;
    predicates.push(Prisma.sql`m.description ILIKE ${'%' + formToken + '%'}`);
  }
  if (filter.route) {
    const routeToken = ROUTE_MATCH[filter.route] ?? filter.route;
    predicates.push(Prisma.sql`m.description ILIKE ${'%' + routeToken + '%'}`);
  }
  const predicate = Prisma.join(predicates, ' AND ');

  return {
    selectColumns: Prisma.sql`
      med.description    AS "medDescription",
      med.generic_name   AS "medGenericName",
      med.strength       AS "medStrength",
      med.strength_unit  AS "medStrengthUnit",
      med.directions     AS "medDirections",
      med.narcotic       AS "medNarcotic"`,
    // Inner LATERAL: a patient with no matching prescription is dropped (the AND filter); the most
    // recently ordered match supplies the citation columns.
    lateralJoin: Prisma.sql`
      JOIN LATERAL (
        SELECT m.description, m.generic_name, m.strength, m.strength_unit, m.directions, m.narcotic
        FROM patient_medication m
        WHERE m.patient_id = p.id
          AND (${predicate})
        ORDER BY m.order_time DESC NULLS LAST
        LIMIT 1
      ) med ON true`,
    annotate: (candidate, row) => {
      candidate.matchedMedication = {
        description: row.medDescription ?? null,
        genericName: row.medGenericName ?? null,
        strength: row.medStrength ?? null,
        strengthUnit: row.medStrengthUnit ?? null,
        directions: row.medDirections ?? null,
        narcotic: row.medNarcotic ?? null,
      };
    },
  };
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

// HNSW search breadth. pgvector's index returns at most `hnsw.ef_search` candidates per scan, so it
// MUST be ≥ CONCEPT_LIMIT or the ANN search would under-return concepts at scale. SET LOCAL (below)
// scopes it to the resolution transaction; it's a harmless no-op when the planner picks an exact scan
// (tiny vocab). Requires pgvector ≥ 0.8 for iterative-scan-aware behavior (this project ships 0.8.2).
const HNSW_EF_SEARCH = 100;

/**
 * Shared Stage-1 scaffolding: embed the query ONCE (outside the txn, so the OpenAI round-trip doesn't
 * hold a DB connection), then run the caller's vocabulary top-K inside a transaction that sets
 * `hnsw.ef_search` for correct ANN recall. Cohort-AGNOSTIC by design — the vocabulary carries no
 * group, so the cohort filter belongs on the Stage-2 patient join, never here.
 */
async function resolveConcepts<Row>(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
  query: string,
  run: (tx: Prisma.TransactionClient, qvec: string) => Promise<Row[]>,
): Promise<Row[]> {
  const qvec = toVectorLiteral(await embeddings.embedQuery(query));
  return prisma.$transaction(async (tx) => {
    // HNSW_EF_SEARCH is a code constant (never user input) and SET rejects bind params, so inline it.
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`);
    return run(tx, qvec);
  });
}

/**
 * Stage 1 — CONCEPT RESOLUTION (condition). Pull the top-CONCEPT_LIMIT closest ICD codes from the
 * shared vocabulary by cosine distance and keep those at/above SIMILARITY_THRESHOLD. The bare
 * `ORDER BY embedding <=> qvec LIMIT k` shape is exactly what the HNSW index serves; the threshold is
 * applied to the ≤k returned rows (NOT as an index-defeating range predicate).
 */
async function resolveConditionConcepts(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
  query: string,
): Promise<ConditionConcept[]> {
  const rows = await resolveConcepts(
    prisma,
    embeddings,
    query,
    (tx, qvec) =>
      tx.$queryRaw<ConditionConcept[]>`
        SELECT code, description, 1 - (embedding <=> ${qvec}::vector) AS similarity
        FROM icd_code
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${qvec}::vector
        LIMIT ${CONCEPT_LIMIT}
      `,
  );
  return rows
    .map((row) => ({
      code: row.code,
      description: row.description,
      similarity: Number(row.similarity),
    }))
    .filter((concept) => concept.similarity >= SIMILARITY_THRESHOLD);
}

/** Stage 1 — CONCEPT RESOLUTION (allergy): same top-K shape against the canonical allergen vocabulary. */
async function resolveAllergenConcepts(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
  query: string,
): Promise<AllergenConcept[]> {
  const rows = await resolveConcepts(
    prisma,
    embeddings,
    query,
    (tx, qvec) =>
      tx.$queryRaw<AllergenConcept[]>`
        SELECT id, canonical_name AS "canonicalName", category,
               1 - (embedding <=> ${qvec}::vector) AS similarity
        FROM allergen
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${qvec}::vector
        LIMIT ${CONCEPT_LIMIT}
      `,
  );
  return rows
    .map((row) => ({
      id: row.id,
      canonicalName: row.canonicalName,
      category: row.category,
      similarity: Number(row.similarity),
    }))
    .filter((concept) => concept.similarity >= SIMILARITY_THRESHOLD);
}

/**
 * Build the condition constraint for the Stage-2 patient query: an inner `LATERAL` that keeps only
 * patients carrying one of the resolved ICD codes and surfaces their best-matching (highest cosine)
 * diagnosis. The resolved `(code, similarity)` pairs are passed as an inline `VALUES` table joined to
 * `patient_condition` on the code — so the patient lookup is a plain indexed equality join (see the
 * `(icd_10_code, patient_id)` index), NOT another vector scan. Cohort scoping is enforced by the
 * outer query's `p."group"` (the lateral reaches `patient_condition` only through `p`). Injection-
 * safe: every code + similarity is a bound parameter.
 */
function buildConditionConstraint(concepts: ConditionConcept[]): PatientConstraint {
  const conceptByCode = new Map(concepts.map((concept) => [concept.code, concept]));
  const values = Prisma.join(
    concepts.map(
      (concept) =>
        Prisma.sql`(${concept.code}::text, ${concept.similarity}::double precision)`,
    ),
    ', ',
  );
  return {
    selectColumns: Prisma.sql`cond.code AS "condCode", cond.sim AS "condSim"`,
    lateralJoin: Prisma.sql`
      JOIN LATERAL (
        SELECT v.code, v.sim
        FROM patient_condition c
        JOIN (VALUES ${values}) AS v(code, sim) ON v.code = c.icd_10_code
        WHERE c.patient_id = p.id
        ORDER BY v.sim DESC
        LIMIT 1
      ) cond ON true`,
    similarityCol: Prisma.sql`cond.sim`,
    annotate: (candidate, row) => {
      if (row.condCode == null) return;
      const concept = conceptByCode.get(row.condCode);
      candidate.matchedCondition = {
        icd10Code: row.condCode,
        icd10Description: concept?.description ?? '',
        similarity: Number(row.condSim),
      };
    },
  };
}

/**
 * Build the allergy constraint for the Stage-2 patient query: an inner `LATERAL` over
 * `patient_allergy` joined to the resolved `(allergen_id, similarity)` pairs (indexed on
 * `allergen_id`), surfacing the patient's best-matching allergen. Cohort scoping via the outer
 * `p."group"`. Canonical name + category come from the already-resolved concept (no extra join).
 */
function buildAllergyConstraint(concepts: AllergenConcept[]): PatientConstraint {
  const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));
  const values = Prisma.join(
    concepts.map(
      (concept) =>
        Prisma.sql`(${concept.id}::text, ${concept.similarity}::double precision)`,
    ),
    ', ',
  );
  return {
    selectColumns: Prisma.sql`alg.allergen_id AS "algId", alg.sim AS "algSim"`,
    lateralJoin: Prisma.sql`
      JOIN LATERAL (
        SELECT v.allergen_id, v.sim
        FROM patient_allergy pa
        JOIN (VALUES ${values}) AS v(allergen_id, sim) ON v.allergen_id = pa.allergen_id
        WHERE pa.patient_id = p.id
        ORDER BY v.sim DESC
        LIMIT 1
      ) alg ON true`,
    similarityCol: Prisma.sql`alg.sim`,
    annotate: (candidate, row) => {
      if (row.algId == null) return;
      const concept = conceptById.get(row.algId);
      candidate.matchedAllergy = {
        canonicalName: concept?.canonicalName ?? row.algId,
        category: concept?.category ?? null,
        similarity: Number(row.algSim),
      };
    },
  };
}

/**
 * Run the single Stage-2 patient query. Each constraint contributes an inner `LATERAL` (filter +
 * matched record) and its SELECT columns; the DB does the intersection, ranking, and `LIMIT` so Node
 * never holds more than the final page (≤MAX_MATCHES) regardless of how many patients match one
 * constraint. Ranking: by the measured value when an observation filter ran (its `orderBy`), else by
 * the strongest cosine similarity across the fuzzy constraints (`GREATEST(...)`), else by patient id.
 *
 * Cohort scoping: `WHERE p."group" = ${group}` — every lateral reaches its table only through `p`.
 * Injection-safe: table/column tokens are constants, the ORDER BY direction is a whitelisted
 * fragment, and every value (group, ILIKE terms, JSON keys, numeric bounds, concept codes +
 * similarities, limit) is a bound parameter.
 */
async function runPatientQuery(
  prisma: PrismaService,
  group: CohortGroup,
  constraints: PatientConstraint[],
): Promise<PatientRow[]> {
  const selectColumns = Prisma.join(
    constraints.map((constraint) => constraint.selectColumns),
    ', ',
  );
  const lateralJoins = Prisma.join(
    constraints.map((constraint) => constraint.lateralJoin),
    ' ',
  );
  const observationOrderBy = constraints.find((constraint) => constraint.orderBy)?.orderBy;
  const similarityCols = constraints
    .map((constraint) => constraint.similarityCol)
    .filter((col): col is Prisma.Sql => col !== undefined);
  const orderBy = observationOrderBy
    ? Prisma.sql`${observationOrderBy}, p.id`
    : similarityCols.length > 0
      ? Prisma.sql`GREATEST(${Prisma.join(similarityCols, ', ')}) DESC, p.id`
      : Prisma.sql`p.id`;

  return prisma.$queryRaw<PatientRow[]>(Prisma.sql`
    SELECT
      p.id AS "patientId",
      ${selectColumns}
    FROM patient p
    ${lateralJoins}
    WHERE p."group" = ${group}
    ORDER BY ${orderBy}
    LIMIT ${MAX_MATCHES}
  `);
}

/** A candidate's strongest fuzzy similarity (condition or allergy); -1 when neither matched. */
function bestSimilarity(candidate: Candidate): number {
  return Math.max(
    candidate.matchedCondition?.similarity ?? -1,
    candidate.matchedAllergy?.similarity ?? -1,
  );
}

/** Assemble the client-facing match: rounded similarities/value + a confidence derived from it. */
function toConditionMatch(patient: PatientDetail, candidate: Candidate): ConditionMatch {
  const matchedCondition = candidate.matchedCondition
    ? {
        ...candidate.matchedCondition,
        similarity: Number(candidate.matchedCondition.similarity.toFixed(4)),
      }
    : undefined;
  const matchedAllergy = candidate.matchedAllergy
    ? {
        ...candidate.matchedAllergy,
        similarity: Number(candidate.matchedAllergy.similarity.toFixed(4)),
      }
    : undefined;
  const matchedObservation = candidate.matchedObservation
    ? {
        ...candidate.matchedObservation,
        value: Number(candidate.matchedObservation.value.toFixed(2)),
      }
    : undefined;
  // A pure deterministic match (measurement and/or medication) is a definite pass ⇒ High; when a
  // fuzzy condition/allergy is also present, confidence reflects that (the only uncertain part).
  const confidence =
    candidate.matchedCondition || candidate.matchedAllergy
      ? toConfidence(bestSimilarity(candidate))
      : ('High' as const);
  return {
    patient,
    matchedCondition,
    matchedAllergy,
    matchedObservation,
    matchedMedication: candidate.matchedMedication,
    confidence,
  };
}

/**
 * Attribute path: search ACROSS patients by condition, allergy, a measurement filter, and/or a
 * medication filter, in any combination. EVERY requested constraint ANDs (a returned patient matches
 * all of them). Two stages keep memory flat regardless of how many patients match one constraint:
 *
 *   • Stage 1 — CONCEPT RESOLUTION (condition, allergy): embed → cosine-rank the cohort-agnostic
 *     `icd_code` / `allergen` VOCABULARY, top-CONCEPT_LIMIT, threshold-filtered. A requested fuzzy
 *     field that resolves to nothing can't match any patient → return early (safe fallback).
 *   • Stage 2 — ONE cohort-scoped patient query whose inner LATERALs (condition, allergy, medication,
 *     observation) intersect, rank, and `LIMIT MAX_MATCHES` IN THE DATABASE — so a single constraint
 *     matching tens of thousands of patients never lands in Node, and there is no JS-side
 *     intersection or per-constraint candidate cap that could drop a valid patient.
 *   • Stage 3 — fetch FULL records for the final ≤MAX_MATCHES patients and assemble in ranked order.
 *
 * Cohort scoping is enforced in the Stage-2 query (`p."group" = ${group}`) and re-applied on the
 * Stage-3 fetch (defense in depth), so no path can surface a patient outside the active cohort.
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
  // ── Stage 1: resolve fuzzy concepts against the shared vocabulary (cohort-agnostic), concurrently. ──
  const [conditionConcepts, allergenConcepts] = await Promise.all([
    conditionQuery
      ? resolveConditionConcepts(prisma, embeddings, conditionQuery)
      : Promise.resolve<ConditionConcept[]>([]),
    allergyQuery
      ? resolveAllergenConcepts(prisma, embeddings, allergyQuery)
      : Promise.resolve<AllergenConcept[]>([]),
  ]);
  // A requested fuzzy field that matched no concept makes every intersection empty — stop now (this
  // also keeps a fuzzy constraint from ever emitting an empty `VALUES ()`).
  if (conditionQuery && conditionConcepts.length === 0) return [];
  if (allergyQuery && allergenConcepts.length === 0) return [];

  // ── Stage 2: assemble the AND-ed constraints and run ONE query that intersects, ranks, and limits
  //    in the DATABASE. ──
  const constraints: PatientConstraint[] = [];
  if (conditionQuery) constraints.push(buildConditionConstraint(conditionConcepts));
  if (allergyQuery) constraints.push(buildAllergyConstraint(allergenConcepts));
  if (medicationFilter) constraints.push(buildMedicationConstraint(medicationFilter));
  if (observationFilter) constraints.push(buildObservationConstraint(observationFilter));
  // The caller only invokes this with ≥1 attribute; guard anyway so we never emit a constraint-less
  // `SELECT … FROM patient` that would return the whole cohort.
  if (constraints.length === 0) return [];

  const rows = await runPatientQuery(prisma, group, constraints);
  if (rows.length === 0) return [];

  const candidates: Candidate[] = rows.map((row) => {
    const candidate: Candidate = { patientId: row.patientId };
    for (const constraint of constraints) constraint.annotate(candidate, row);
    return candidate;
  });

  // ── Stage 3: fetch FULL records for the final ≤MAX_MATCHES patients (group-scoped — defense in
  //    depth) and assemble in the DB-ranked order. ──
  const patientRecords = await prisma.patient.findMany({
    where: { id: { in: candidates.map((candidate) => candidate.patientId) }, group },
    include: patientInclude,
  });
  const patientDetailsById = new Map(
    patientRecords.map((patient) => [patient.id, toPatientDetail(patient)]),
  );

  return candidates
    .map((candidate): ConditionMatch | null => {
      const patient = patientDetailsById.get(candidate.patientId);
      return patient ? toConditionMatch(patient, candidate) : null;
    })
    .filter((match): match is ConditionMatch => match !== null);
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
