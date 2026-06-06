"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { login, type AdminSession } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({ onSuccess }: { onSuccess: (session: AdminSession) => void }) {
  const [user, setUser] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const session = await login(user.trim(), password);
      onSuccess(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm p-0">
        <div className="space-y-6 p-7">
          <div className="space-y-1.5">
            <div className="mb-3 flex items-center gap-2">
              <div className="grid size-9 place-items-center rounded-xl bg-primary font-heading text-lg font-bold text-primary-foreground">
                C
              </div>
              <span className="font-heading text-lg font-semibold">CareBrain</span>
            </div>
            <h1 className="font-heading text-xl font-semibold">Admin · Observability</h1>
            <p className="text-sm text-muted-foreground">
              Sign in to view the request audit log.
            </p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="user">Username</Label>
              <Input
                id="user"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                autoComplete="username"
                placeholder="admin"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="••••••"
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" size="lg" className="w-full" disabled={loading}>
              {loading && <Loader2 className="size-4 animate-spin" />}
              Sign in
            </Button>
          </form>
        </div>
      </Card>
    </main>
  );
}
