"use client";

import * as React from "react";
import { LogOut, RefreshCw } from "lucide-react";

import { ApiError, fetchCategoryMetrics, fetchLogs, fetchMetrics } from "@/lib/api";
import { clearSession, type AdminSession } from "@/lib/auth";
import type { CategoryMetrics, RequestLog, VariantMetrics } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LogsTable } from "./logs-table";
import { LogDetailSheet } from "./log-detail-sheet";
import { MetricsSummary } from "./metrics-summary";
import { CategoryMetricsCard } from "./category-metrics";

export function LogsView({
  session,
  onSignOut,
}: {
  session: AdminSession;
  onSignOut: () => void;
}) {
  const [logs, setLogs] = React.useState<RequestLog[]>([]);
  const [metrics, setMetrics] = React.useState<VariantMetrics[]>([]);
  const [categoryMetrics, setCategoryMetrics] = React.useState<CategoryMetrics[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<RequestLog | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The metrics cards are a best-effort header — never let them block the log table.
      const [data, metricsData, categoryData] = await Promise.all([
        fetchLogs(session.token, { limit: 500 }),
        fetchMetrics(session.token).catch(() => [] as VariantMetrics[]),
        fetchCategoryMetrics(session.token).catch(() => [] as CategoryMetrics[]),
      ]);
      setLogs(data);
      setMetrics(metricsData);
      setCategoryMetrics(categoryData);
    } catch (err) {
      // An expired/invalid token means the gate must re-authenticate.
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        onSignOut();
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load logs");
    } finally {
      setLoading(false);
    }
  }, [session.token, onSignOut]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function handleSignOut() {
    clearSession();
    onSignOut();
  }

  function openLog(log: RequestLog) {
    setSelected(log);
    setSheetOpen(true);
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-xl bg-primary font-heading text-lg font-bold text-primary-foreground">
            C
          </div>
          <div>
            <h1 className="font-heading text-lg leading-tight font-semibold">Observability</h1>
            <p className="text-xs text-muted-foreground">Patient Q&amp;A · request audit log</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            <LogOut className="size-3.5" />
            Sign out
          </Button>
        </div>
      </header>

      {error ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <MetricsSummary metrics={metrics} />
            <CategoryMetricsCard metrics={categoryMetrics} />
          </div>
          <LogsTable data={logs} onRowClick={openLog} />
        </>
      )}

      <LogDetailSheet log={selected} open={sheetOpen} onOpenChange={setSheetOpen} />
    </main>
  );
}
