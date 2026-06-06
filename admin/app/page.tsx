"use client";

import * as React from "react";

import { getSession, type AdminSession } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";
import { LogsView } from "@/components/logs-view";

// Client-side auth gate. The page is prerendered (static export) showing a neutral splash;
// after mount we read the stored session from localStorage and swap in the login form or the
// logs view. Keeping the first client render identical to the prerender (the splash) avoids
// any hydration mismatch from touching `localStorage` during render.
export default function Page() {
  const [session, setSession] = React.useState<AdminSession | null>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    setSession(getSession());
    setReady(true);
  }, []);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </main>
    );
  }

  if (!session) {
    return <LoginForm onSuccess={setSession} />;
  }

  return <LogsView session={session} onSignOut={() => setSession(null)} />;
}
