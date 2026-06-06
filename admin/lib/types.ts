// Observability log types — mirrored 1:1 from the backend (independent app, same as how
// the Expo frontend mirrors backend types). Source of truth: the `request_log` Prisma model
// (backend/prisma/schema.prisma) + RequestTrace (backend/src/shared/observability/request-log.service.ts).

export type CohortGroup = "A" | "B";

export type Outcome =
  | "answered"
  | "patients_found"
  | "no_match"
  | "cohort_violation"
  | "injection_refused"
  | "not_answerable"
  | "error";

export type Severity = "none" | "low" | "medium" | "high";

export type Confidence = "High" | "Medium" | "Low";

export type RetrievalPath = "identity" | "attribute" | "none";

/** One prior conversation turn (sanitized server-side). */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Provenance pointer — source table + record key, no PHI body. */
export interface SourceRef {
  table: string;
  id: string;
}

/** One row of the observability audit log, as returned by `GET /qa/logs`. */
export interface RequestLog {
  id: string;
  traceId: string;
  createdAt: string;
  group: CohortGroup;
  agent: string | null;
  question: string;
  history: ChatTurn[] | null;
  resolvedPatientId: string | null;
  retrievalPath: RetrievalPath;
  recordsRetrieved: SourceRef[] | null;
  rawModelOutput: string | null;
  answer: string | null;
  confidence: Confidence | null;
  citations: string[] | null;
  outcome: Outcome;
  fallbackUsed: boolean;
  injectionDetected: boolean;
  cohortViolation: boolean;
  severity: Severity;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
}
