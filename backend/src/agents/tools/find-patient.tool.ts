import { tool } from 'langchain';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Input schema: resolve a patient by ID and/or name — both optional. The LLM extracts
 * whichever the user supplied from the chat message. ID is the authoritative signal; a
 * name is the fallback.
 */
export const findPatientToolSchema = z.object({
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
      "The patient's name (full, or just first or last) if given, e.g. 'Adolfo Ricker'.",
    ),
});

export type FindPatientToolInput = z.infer<typeof findPatientToolSchema>;

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

export interface FindPatientResult {
  query: { patientId?: string; name?: string };
  matchCount: number;
  patients: PatientDetail[];
}

const MAX_MATCHES = 5;
const OBSERVATION_LIMIT = 50;

/** Date-only (`YYYY-MM-DD`) for `@db.Date` columns. */
const dateOnly = (d: Date | null): string | null =>
  d ? d.toISOString().slice(0, 10) : null;
/** Full ISO timestamp for `@db.Timestamptz` columns. */
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The full-record `include` shape: every child table, observations capped to the most recent.
 * Shared so both retrieval tools (find_patient and find_patients_by_condition) return identical
 * patient payloads.
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
 * Build the Prisma `where` for the supplied criteria, precision-first:
 *   1. ID present  -> exact match on `patient.id` (authoritative; short-circuits).
 *   2. else name   -> the name is split into whitespace tokens and every token must appear
 *                     (case-insensitively) in the first OR last name, so 'Adolfo Ricker'
 *                     matches first='Adolfo' last='Ricker' and a single token matches either.
 *   3. neither     -> null: no criteria, so we skip the DB entirely (never list all patients).
 *
 * Cohort scoping is intentionally not applied yet — the search spans every patient; each
 * match still reports its `group` for transparency.
 */
function buildWhere({ patientId, name }: FindPatientToolInput) {
  const id = patientId?.trim();
  if (id) return { id };

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

/**
 * Factory: returns a LangChain tool that resolves patient(s) by ID and/or name and returns
 * the COMPLETE record for each — all demographics plus every condition, medication, allergy
 * and observation. The result is the terminal step of the agent (see
 * `createTerminateAfterToolMiddleware`): it is returned to the client verbatim, not summarized
 * by the model, so the UI can render the full patient object.
 */
export function createFindPatientTool(prisma: PrismaService) {
  return tool(
    async (input: FindPatientToolInput): Promise<FindPatientResult> => {
      const query = { patientId: input.patientId, name: input.name };
      const where = buildWhere(input);

      // No usable criteria -> empty result (the agent should emit the safe fallback).
      if (!where) return { query, matchCount: 0, patients: [] };

      // `include`-style full fetch: pull every column of the patient and each child table.
      const patients = await prisma.patient.findMany({
        where,
        take: MAX_MATCHES,
        orderBy: [{ nameLast: 'asc' }, { nameFirst: 'asc' }],
        include: patientInclude,
      });

      const detailed: PatientDetail[] = patients.map(toPatientDetail);

      return { query, matchCount: detailed.length, patients: detailed };
    },
    {
      name: 'find_patient',
      description: `Resolve a patient by ID and/or name and return their COMPLETE record:
                    demographics, every condition, medication, allergy, and recent observations.
                    Pass the patient UUID (preferred when given) and/or a full/partial name.
                    Searches across all patients; returns matchCount 0 when nothing matches.`,
      schema: findPatientToolSchema,
    },
  );
}
