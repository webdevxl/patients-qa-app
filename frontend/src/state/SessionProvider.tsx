// Session state: which cohort the clinician is currently operating inside.
//
// This is the UI-layer expression of the app's central safety invariant — there is
// always exactly ONE active cohort, and every screen reads it from here rather than
// passing it around ad hoc. Today the session is just the chosen group; once the
// backend's group-selection endpoint exists (build-out plan #1), the returned
// session token slots into `token` with no change to consumers.
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import type { CohortGroup } from '../theme/palette';

export interface Session {
  group: CohortGroup;
  /** Basic-auth session token from the backend. Reserved for build-out plan #1. */
  token?: string;
}

interface SessionContextValue {
  session: Session | null;
  /** Enter a cohort. `clearCohort` is the only way back out (explicit switch). */
  selectCohort: (group: CohortGroup, token?: string) => void;
  clearCohort: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  const selectCohort = useCallback((group: CohortGroup, token?: string) => {
    setSession({ group, token });
  }, []);

  const clearCohort = useCallback(() => setSession(null), []);

  const value = useMemo(
    () => ({ session, selectCohort, clearCohort }),
    [session, selectCohort, clearCohort],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
