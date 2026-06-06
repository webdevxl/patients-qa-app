// Thin, typed HTTP client for the Nest backend.
//
// Base URL resolves from `EXPO_PUBLIC_API_URL` (Expo inlines `EXPO_PUBLIC_*` at build
// time) and falls back to localhost:3000 — the backend's default port. Keeping this
// in one place means the eventual hosted deployment only changes an env var.
import { fetch as expoFetch } from 'expo/fetch';
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
  group: CohortGroup;
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
/** Which reading of a two-field BloodPressure measurement was compared. */
export type BloodPressureComponent = 'systolic' | 'diastolic';

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
  /** Set for measurement searches — the reading that passed the numeric filter. */
  matchedObservation?: {
    metric: string;
    component?: BloodPressureComponent;
    value: number;
    unit: string | null;
    recordedTime: string | null;
  };
  /** Set for medication searches — the prescription that matched (drug + dose/form/route). */
  matchedMedication?: {
    description: string | null;
    genericName: string | null;
    strength: string | null;
    strengthUnit: string | null;
    /** Dosing instructions — answers "how often". */
    directions: string | null;
    narcotic: boolean | null;
  };
  confidence: 'High' | 'Medium' | 'Low';
}

/**
 * Result returned by the backend's `/qa/query` route — the single chat endpoint with two modes:
 *
 * FIND mode (no `patientId` sent) — resolve/search patients in the cohort:
 *   • patients       — full record(s) when a specific patient was resolved (find_patient).
 *   • matches        — per-patient hits when searching by condition/allergy.
 *   • fallback       — set instead when nothing matched.
 *   • contextSummary — compact one-line summary of what resolved; echo it back as the assistant
 *                      turn in `history` so follow-ups ("what about his allergies?") resolve.
 *
 * ANSWER mode (`patientId` sent — a patient is already selected) — grounded answer about THAT patient:
 *   • answer         — concise prose grounded only in that patient's records.
 *   • confidence     — High/Medium/Low calibration over the supporting evidence.
 *   • citations      — source-record labels ([C1], [M2], …) the answer relied on.
 * A patient-scoped request that can't be answered still comes back as `fallback`.
 */
/**
 * Best-effort token usage for the single LLM call a request made — mirrors the backend's
 * `RequestUsage` (backend/src/agents/agent-base.ts). Absent when no model call ran (e.g. an empty
 * question). `contextWindow` is the backend's own tunable budget the UI charts the conversation
 * against, so the client never hardcodes it.
 */
export interface RequestUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model: string;
  contextWindow: number;
}

export interface QaResult {
  question: string;
  matchCount: number;
  patients?: PatientDetail[];
  matches?: ConditionMatch[];
  fallback?: string;
  contextSummary?: string;
  answer?: string;
  confidence?: 'High' | 'Medium' | 'Low';
  citations?: string[];
  usage?: RequestUsage;
}

/** Which agent/phase produced a turn — mirrors the backend `AgentName` (backend/src/agents/agent-base.ts). */
export type AgentName = 'find-patient' | 'answer-patient';

/**
 * One prior conversation turn sent so the backend can resolve follow-up references. Assistant
 * content is the compact `contextSummary` (never a full record). The backend sanitizes/trims it.
 *
 * `agentName` is REQUIRED — every turn declares its phase so the backend can feed the answer-patient
 * agent only its own (answer-phase) turns. `patientId` is set only on answer-phase turns (the
 * patient that turn is about), so scoping keeps just the active patient's turns.
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  agentName: AgentName;
  patientId?: string;
}

/**
 * A patient candidate shown in the disambiguation list (when a find returns more than one). Carries
 * the full record (so selecting needs no extra request) plus, for attribute searches, what they
 * matched on (rendered as a richer row). Defined here — a neutral module — so both the row component
 * and the chat-message type can reference it without a circular import.
 */
export interface CandidateItem {
  patient: PatientDetail;
  match?: ConditionMatch;
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

async function postJson<T>(
  path: string,
  body: unknown,
  token?: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The session token is already a ready-to-use Basic credential — the backend minted it
        // as base64("<jwt>:"), so we just echo it back. Omitted on the group-selection call.
        ...(token ? { Authorization: `Basic ${token}` } : {}),
      },
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
 * Select a cohort and obtain a session token. This is the only unauthenticated call — its result
 * (`token`) authorizes every subsequent request and encodes (server-side, signed) which group the
 * caller may see. The client treats the token as opaque.
 */
export function postSelectGroup(
  group: CohortGroup,
): Promise<{ token: string; group: CohortGroup }> {
  return postJson<{ token: string; group: CohortGroup }>('/auth/session', {
    group,
  });
}

/**
 * The one chat call. `token` is the session credential (required) and is a separate argument from
 * the body precisely because it's transport/auth, not request data — it's sent as the Basic auth
 * header, never in the body. The backend derives the active cohort from the token (never the body),
 * so the client cannot ask outside its group. `history` is client-supplied (stateless backend) to
 * resolve follow-up references.
 *
 * `patientId` (optional) switches the backend into ANSWER mode: when a patient is already selected,
 * send its id and the backend answers the question from THAT patient's records (re-verified under
 * the cohort). Omit it to FIND/search patients.
 */
export function postQaQuery(
  token: string,
  body: { question: string; history?: ChatTurn[]; patientId?: string; sessionId?: string },
): Promise<QaResult> {
  return postJson<QaResult>('/qa/query', body, token);
}

// ── Streaming chat (`/qa/stream`) ─────────────────────────────────────────────────────────────
//
// Mirrors the backend's QaStreamEvent (backend/src/api/qa/qa-stream.types.ts). The ANSWER path
// streams the grounded prose as `token` events (each `text` is the answer-SO-FAR, cumulative), then
// exactly one terminal event: `result` (the authoritative QaResult, identical to `/qa/query`) on
// success, or `error` on failure. The FIND path emits no tokens — just its `result`.

/** One Server-Sent-Events payload from `/qa/stream` — mirrors the backend `QaStreamEvent`. */
export type QaStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'result'; result: QaResult }
  | { type: 'error'; message: string };

export interface QaStreamHandlers {
  /** Called with the cumulative answer-so-far on each token (just assign it — no concat needed). */
  onToken: (cumulativeAnswer: string) => void;
  /** Called once with the authoritative result; finalize the bubble (answer/confidence/citations/usage). */
  onResult: (result: QaResult) => void;
  /** Called on a stream-level error event; treat like the safe fallback. */
  onError: (message: string) => void;
}

/**
 * Streaming twin of {@link postQaQuery}, used for the patient-scoped ANSWER path so the grounded
 * answer renders token-by-token. Uses `expo/fetch` — a universal (web + native) WHATWG fetch whose
 * `body` is a real `ReadableStream` — and parses the SSE `data:` frames. Auth + base URL match the
 * non-streaming client; a 401 throws `ApiError(401)` so the caller can drop back to the cohort picker.
 * Resolves when the stream closes (after the terminal event).
 */
export async function streamQaQuery(
  token: string,
  body: { question: string; history?: ChatTurn[]; patientId?: string; sessionId?: string },
  handlers: QaStreamHandlers,
): Promise<void> {
  let res;
  try {
    res = await expoFetch(`${API_BASE_URL}/qa/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(`Cannot reach the backend at ${API_BASE_URL}. Is it running?`);
  }
  if (res.status === 401) throw new ApiError('Request failed (401)', 401);
  if (!res.ok) throw new ApiError(`Request failed (${res.status})`, res.status);
  if (!res.body) {
    // No stream body available — surface as an error so the caller renders the safe fallback.
    handlers.onError('no_stream');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // SSE frames are separated by a blank line; each frame's `data:` line carries one JSON event.
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      let evt: QaStreamEvent;
      try {
        evt = JSON.parse(json) as QaStreamEvent;
      } catch {
        continue; // ignore a malformed/partial frame defensively
      }
      if (evt.type === 'token') handlers.onToken(evt.text);
      else if (evt.type === 'result') handlers.onResult(evt.result);
      else if (evt.type === 'error') handlers.onError(evt.message);
    }
  }
}
