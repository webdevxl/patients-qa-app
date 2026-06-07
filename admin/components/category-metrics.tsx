"use client";

import type { CategoryMetrics, EvalCategory } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryBadge } from "./status-badges";

// The eval scorecard (task §6 "measure performance") — one row per eval category showing how often
// the assistant did the right thing for prompts designed to test that category: pass = a real answer
// for `normal`, a refusal for `prompt_injection`/`cross_cohort`, a graceful fallback for
// `insufficient_context` (the backend owns the per-category pass rule; this just renders it). Sits
// beside the A/B variant card; both are fed straight from the audit log so the numbers can't drift.

// Stable order: the "should succeed" category first, then the three "should be refused / fall back".
const CATEGORY_ORDER: EvalCategory[] = [
  "normal",
  "prompt_injection",
  "cross_cohort",
  "insufficient_context",
];

/** Compact "outcome×n, …" breakdown so a reviewer can see *how* the misses failed. */
function outcomeBreakdown(outcomes: Record<string, number>): string {
  const parts = Object.entries(outcomes)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`);
  return parts.join(" · ");
}

export function CategoryMetricsCard({ metrics }: { metrics: CategoryMetrics[] }) {
  if (metrics.length === 0) return null;
  const byCat = new Map(metrics.map((m) => [m.category, m]));
  const ordered = CATEGORY_ORDER.map((c) => byCat.get(c)).filter(
    (m): m is CategoryMetrics => m !== undefined,
  );

  return (
    <Card className="mb-5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">
          Eval scorecard · per-category pass rate
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-[1.6fr_1fr_1fr] items-center gap-2 border-b pb-2 text-xs text-muted-foreground">
          <span>Category</span>
          <span className="text-right">Passed</span>
          <span className="text-right">Pass rate</span>
        </div>
        <div className="divide-y">
          {ordered.map((m) => (
            <div key={m.category} className="py-1.5">
              <div className="grid grid-cols-[1.6fr_1fr_1fr] items-center gap-2">
                <span>
                  <CategoryBadge value={m.category} />
                </span>
                <span className="text-right text-sm tabular-nums">
                  {m.passed}/{m.total}
                </span>
                <span className="text-right text-sm font-medium tabular-nums">
                  {m.passRate === null ? "—" : `${m.passRate}%`}
                </span>
              </div>
              {m.total > 0 ? (
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {outcomeBreakdown(m.outcomes)}
                </p>
              ) : (
                <p className="mt-0.5 text-[11px] text-muted-foreground/70">not yet exercised</p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
