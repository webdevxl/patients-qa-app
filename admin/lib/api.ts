// Thin, typed HTTP client for the Nest backend — mirrors the pattern in
// frontend/src/api/client.ts. Base URL resolves from NEXT_PUBLIC_API_URL (Next inlines
// NEXT_PUBLIC_* at build time) and falls back to the backend's default dev port.
import type { CohortGroup, RequestLog, VariantMetrics } from "./types";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Mint a cohort session token. This is the only unauthenticated call. The token is
 * already a ready-to-use Basic credential (the backend minted it as base64("<jwt>:")),
 * so callers just echo it back as `Authorization: Basic <token>`.
 */
export async function mintToken(group: CohortGroup): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group }),
    });
  } catch {
    throw new ApiError(`Cannot reach the backend at ${API_BASE_URL}. Is it running?`);
  }
  if (!res.ok) {
    throw new ApiError(`Failed to mint session token (${res.status})`, res.status);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

export interface LogFilters {
  outcome?: string;
  group?: string;
  variant?: string;
  agent?: string;
  cohortViolation?: boolean;
  limit?: number;
}

/**
 * Fetch the observability log. Returns a flat, newest-first array of full rows (the
 * backend applies no pagination envelope), so the detail view reuses the row in hand.
 */
export async function fetchLogs(
  token: string,
  filters: LogFilters = {},
): Promise<RequestLog[]> {
  const params = new URLSearchParams();
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.group) params.set("group", filters.group);
  if (filters.variant) params.set("variant", filters.variant);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.cohortViolation !== undefined) {
    params.set("cohortViolation", String(filters.cohortViolation));
  }
  params.set("limit", String(filters.limit ?? 500));

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/qa/logs?${params.toString()}`, {
      headers: { Authorization: `Basic ${token}` },
    });
  } catch {
    throw new ApiError(`Cannot reach the backend at ${API_BASE_URL}. Is it running?`);
  }
  if (res.status === 401) {
    throw new ApiError("Session expired — please sign in again.", 401);
  }
  if (!res.ok) {
    throw new ApiError(`Failed to load logs (${res.status})`, res.status);
  }
  return (await res.json()) as RequestLog[];
}

/**
 * Fetch per-variant A/B experiment metrics (`GET /qa/metrics`) — one aggregate row per arm,
 * computed by the backend straight from the audit log. Drives the A/B summary card.
 */
export async function fetchMetrics(token: string): Promise<VariantMetrics[]> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/qa/metrics`, {
      headers: { Authorization: `Basic ${token}` },
    });
  } catch {
    throw new ApiError(`Cannot reach the backend at ${API_BASE_URL}. Is it running?`);
  }
  if (res.status === 401) {
    throw new ApiError("Session expired — please sign in again.", 401);
  }
  if (!res.ok) {
    throw new ApiError(`Failed to load metrics (${res.status})`, res.status);
  }
  return (await res.json()) as VariantMetrics[];
}
