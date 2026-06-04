import { tool } from 'langchain';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';

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

/** Full detail returned for a single matched patient. */
export interface PatientDetail {
  id: string;
  nameFirst: string | null;
  nameLast: string | null;
  dob: string | null;
  gender: string | null;
  status: string | null;
  group: string;
  conditions: Array<{
    icd10Code: string | null;
    icd10Description: string | null;
    clinicalStatus: string | null;
    isPrimaryDiagnosis: boolean | null;
  }>;
  medications: Array<{
    description: string | null;
    genericName: string | null;
    strength: string | null;
    strengthUnit: string | null;
    directions: string | null;
    status: string | null;
    narcotic: boolean | null;
  }>;
  allergies: Array<{
    allergen: string | null;
    category: string | null;
    severity: string | null;
    reactionType: string | null;
    clinicalStatus: string | null;
  }>;
  observations: Array<{
    method: string | null;
    recordedTime: string | null;
    data: unknown;
  }>;
}

export interface FindPatientResult {
  query: { patientId?: string; name?: string };
  matchCount: number;
  patients: PatientDetail[];
}

const MAX_MATCHES = 5;
const OBSERVATION_LIMIT = 25;

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
 * their details (demographics + conditions + medications + allergies + a sample of
 * observations).
 */
export function createFindPatientTool(prisma: PrismaService) {
  return tool(
    async (input: FindPatientToolInput): Promise<FindPatientResult> => {
      const query = { patientId: input.patientId, name: input.name };
      const where = buildWhere(input);

      // No usable criteria -> empty result (the agent should emit the safe fallback).
      if (!where) return { query, matchCount: 0, patients: [] };

      const patients = await prisma.patient.findMany({
        where,
        take: MAX_MATCHES,
        orderBy: [{ nameLast: 'asc' }, { nameFirst: 'asc' }],
        select: {
          id: true,
          nameFirst: true,
          nameLast: true,
          dob: true,
          gender: true,
          status: true,
          group: true,
          conditions: {
            select: {
              icd10Code: true,
              icd10Description: true,
              clinicalStatus: true,
              isPrimaryDiagnosis: true,
            },
          },
          medications: {
            select: {
              description: true,
              genericName: true,
              strength: true,
              strengthUnit: true,
              directions: true,
              status: true,
              narcotic: true,
            },
          },
          allergies: {
            select: {
              allergen: true,
              category: true,
              severity: true,
              reactionType: true,
              clinicalStatus: true,
            },
          },
          observations: {
            select: { method: true, recordedTime: true, data: true },
            take: OBSERVATION_LIMIT,
          },
        },
      });

      const detailed: PatientDetail[] = patients.map((p) => ({
        id: p.id,
        nameFirst: p.nameFirst,
        nameLast: p.nameLast,
        dob: p.dob ? p.dob.toISOString().slice(0, 10) : null,
        gender: p.gender,
        status: p.status,
        group: p.group,
        conditions: p.conditions,
        medications: p.medications,
        allergies: p.allergies,
        observations: p.observations.map((o) => ({
          method: o.method,
          recordedTime: o.recordedTime ? o.recordedTime.toISOString() : null,
          data: o.data,
        })),
      }));

      return { query, matchCount: detailed.length, patients: detailed };
    },
    {
      name: 'find_patient',
      description: `Resolve a patient by ID and/or name and return their details: demographics,
                    conditions, medications, allergies, and recent observations. Pass the patient
                    UUID (preferred when given) and/or a full/partial name. Searches across all
                    patients; returns matchCount 0 when nothing matches.`,
      schema: findPatientToolSchema,
    },
  );
}
