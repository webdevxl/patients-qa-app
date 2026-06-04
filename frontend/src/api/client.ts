// Thin, typed HTTP client for the Nest backend.
//
// Base URL resolves from `EXPO_PUBLIC_API_URL` (Expo inlines `EXPO_PUBLIC_*` at build
// time) and falls back to localhost:3000 — the backend's default port. Keeping this
// in one place means the eventual hosted deployment only changes an env var.
import type { CohortGroup } from '../theme/palette';

export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';

/** Result returned by the backend's `/qa/query` route. */
export interface QaResult {
  group: CohortGroup;
  question: string;
  answer: string;
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
