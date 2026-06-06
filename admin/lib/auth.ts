// Primitive admin auth — a UI gate only, intentionally minimal (per the brief).
//
// ⚠️ This is NOT real security: NEXT_PUBLIC_* vars are inlined into the browser bundle,
// so the credentials are visible client-side. It exists to keep the panel from being wide
// open at a glance; a real deployment would gate /qa/logs behind a server-side admin role
// (see SECURITY.md). The actual API authorization still uses the cohort session token.
import { mintToken } from "./api";

const STORAGE_KEY = "carebrain_admin_session";

const ADMIN_USER = process.env.NEXT_PUBLIC_ADMIN_USER ?? "admin";
const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD ?? "admin";

export interface AdminSession {
  token: string;
}

/** Read the stored session, or null. Safe to call during prerender (returns null). */
export function getSession(): AdminSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdminSession;
    return parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Validate the hardcoded credentials, then mint a cohort session token (group A) so the
 * underlying /qa/logs calls authorize. Logs span BOTH cohorts regardless of the token's
 * group, so 'A' is arbitrary. Persists the session in localStorage on success.
 */
export async function login(user: string, password: string): Promise<AdminSession> {
  if (user !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    throw new Error("Invalid username or password");
  }
  const token = await mintToken("A");
  const session: AdminSession = { token };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}
