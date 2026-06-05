// Thin, typed HTTP client for the Nest backend.
//
// Base URL resolves from `EXPO_PUBLIC_API_URL` (Expo inlines `EXPO_PUBLIC_*` at build
// time) and falls back to localhost:3000 — the backend's default port. Keeping this
// in one place means the eventual hosted deployment only changes an env var.
import type { CohortGroup } from '../theme/palette';

export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';

// ── Patient record types — mirror the backend's find_patient tool output 1:1
//    (backend/src/agents/tools/find-patient.tool.ts). The agent returns the FULL
//    record so the UI can render it directly. ──

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
  data: unknown;
}

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
  unitDescription: string | null;
  floorDescription: string | null;
  roomDescription: string | null;
  bedDescription: string | null;
  admissionTime: string | null;
  dischargeTime: string | null;
  deathTime: string | null;
  revBy: string | null;
  revTime: string | null;
  conditions: ConditionDetail[];
  medications: MedicationDetail[];
  allergies: AllergyDetail[];
  observations: ObservationDetail[];
}

/**
 * One patient surfaced by the semantic search (find_patients_by_condition — which serves both
 * condition and allergy queries). Carries the patient's COMPLETE record (so the detail view
 * renders on tap without another request) plus what they matched on. Exactly one of
 * `matchedCondition` / `matchedAllergy` is set per match. Mirrors the backend ConditionMatch
 * (backend/src/agents/tools/find-patients-by-condition.tool.ts).
 */
export interface ConditionMatch {
  patient: PatientDetail;
  /** Set for condition searches — the matched ICD-10 diagnosis. */
  matchedCondition?: {
    icd10Code: string;
    icd10Description: string;
    /** Cosine similarity in [-1, 1]; higher = closer. */
    similarity: number;
  };
  /** Set for allergy searches — the matched canonical allergen. */
  matchedAllergy?: {
    canonicalName: string;
    category: string | null;
    /** Cosine similarity in [-1, 1]; higher = closer. */
    similarity: number;
  };
  confidence: 'High' | 'Medium' | 'Low';
}

/**
 * Result returned by the backend's `/qa/query` route. The agent routes to one of two tools, so
 * exactly one result array is populated:
 *   • patients — full record(s) when a specific patient was resolved (find_patient).
 *   • matches  — light per-patient hits when searching by condition (find_patients_by_condition).
 *   • fallback — set instead when nothing matched.
 */
export interface QaResult {
  question: string;
  matchCount: number;
  patients?: PatientDetail[];
  matches?: ConditionMatch[];
  fallback?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(
      `Cannot reach the backend at ${API_BASE_URL}. Is it running?`,
    );
  }
  if (!res.ok) {
    throw new ApiError(`Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * Ask a cohort-scoped question. The backend's `/qa/query` route runs the LangChain
 * patient Q&A agent over the given cohort and free-text question. The cohort is always
 * sent explicitly so the request is answered against the chosen group.
 */
export function postQaQuery(params: {
  group: CohortGroup;
  question: string;
}): Promise<QaResult> {
  return postJson<QaResult>('/qa/query', params);
}
