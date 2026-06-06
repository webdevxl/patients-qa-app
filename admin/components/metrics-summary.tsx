"use client";

import type { VariantMetrics } from "@/lib/types";
import { formatNumber } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VariantBadge } from "./status-badges";

// Compact A/B comparison card — one column per arm, fed by `GET /qa/metrics`. Audit-first: it
// surfaces the experiment numbers (requests, fallback/violation rates, avg tokens + latency) right
// above the log table so the A/B test is legible at a glance. Mirrors what EXPERIMENT_RESULTS.md
// reports, straight from the same audit-log aggregation.

/** A labeled stat with the value rendered per arm. */
function StatRow({
  label,
  render,
  metrics,
}: {
  label: string;
  render: (m: VariantMetrics) => string;
  metrics: VariantMetrics[];
}) {
  return (
    <div className="grid grid-cols-[1.4fr_1fr_1fr] items-center gap-2 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {metrics.map((m) => (
        <span key={m.variant} className="text-right text-sm font-medium tabular-nums">
          {render(m)}
        </span>
      ))}
    </div>
  );
}

const pct = (n: number, total: number): string =>
  total === 0 ? "—" : `${Math.round((n / total) * 100)}%`;

export function MetricsSummary({ metrics }: { metrics: VariantMetrics[] }) {
  if (metrics.length === 0) return null;
  // Stable order: structured (control) first, then tool_calling.
  const ordered = [...metrics].sort((a, b) =>
    a.variant === "structured" ? -1 : b.variant === "structured" ? 1 : 0,
  );

  return (
    <Card className="mb-5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">A/B experiment · per-variant metrics</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-[1.4fr_1fr_1fr] items-center gap-2 border-b pb-2">
          <span />
          {ordered.map((m) => (
            <div key={m.variant} className="flex justify-end">
              <VariantBadge value={m.variant} />
            </div>
          ))}
        </div>
        <div className="divide-y">
          <StatRow label="Requests" metrics={ordered} render={(m) => formatNumber(m.total)} />
          <StatRow
            label="Answered"
            metrics={ordered}
            render={(m) => `${m.outcomes.answered ?? 0} (${pct(m.outcomes.answered ?? 0, m.total)})`}
          />
          <StatRow
            label="Fallback rate"
            metrics={ordered}
            render={(m) => pct(m.fallbackUsed, m.total)}
          />
          <StatRow
            label="Injection flagged"
            metrics={ordered}
            render={(m) => formatNumber(m.injectionDetected)}
          />
          <StatRow
            label="Cohort violations"
            metrics={ordered}
            render={(m) => formatNumber(m.cohortViolation)}
          />
          <StatRow
            label="Avg tokens (total)"
            metrics={ordered}
            render={(m) => formatNumber(m.avgTotalTokens)}
          />
          <StatRow
            label="Avg latency"
            metrics={ordered}
            render={(m) => (m.avgDurationMs == null ? "—" : `${formatNumber(m.avgDurationMs)} ms`)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
