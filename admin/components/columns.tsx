"use client";

import type { Column, ColumnDef } from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";

import type { RequestLog, Severity } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatDateTime, formatNumber } from "@/lib/format";
import {
  ConfidenceBadge,
  GroupBadge,
  OutcomeBadge,
  SeverityBadge,
  VariantBadge,
} from "./status-badges";

const severityOrder: Record<Severity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function SortHeader({
  column,
  label,
}: {
  column: Column<RequestLog, unknown>;
  label: string;
}) {
  const sorted = column.getIsSorted();
  return (
    <button
      type="button"
      onClick={() => column.toggleSorting(sorted === "asc")}
      className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 font-medium hover:text-foreground"
    >
      {label}
      {sorted === "asc" ? (
        <ChevronUp className="size-3.5" />
      ) : sorted === "desc" ? (
        <ChevronDown className="size-3.5" />
      ) : (
        <ChevronsUpDown className="size-3.5 opacity-40" />
      )}
    </button>
  );
}

export const columns: ColumnDef<RequestLog>[] = [
  {
    accessorKey: "createdAt",
    header: ({ column }) => <SortHeader column={column} label="Time" />,
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatDateTime(row.original.createdAt)}
      </span>
    ),
  },
  {
    accessorKey: "group",
    header: "Cohort",
    cell: ({ row }) => <GroupBadge value={row.original.group} />,
  },
  {
    accessorKey: "variant",
    header: "Variant",
    cell: ({ row }) => <VariantBadge value={row.original.variant} />,
    filterFn: (row, id, value) => row.getValue(id) === value,
  },
  {
    accessorKey: "agent",
    header: "Agent",
    cell: ({ row }) =>
      row.original.agent ? (
        <span className="text-sm">{row.original.agent}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    accessorKey: "outcome",
    header: "Outcome",
    cell: ({ row }) => <OutcomeBadge value={row.original.outcome} />,
    filterFn: (row, id, value) => row.getValue(id) === value,
  },
  {
    accessorKey: "severity",
    header: ({ column }) => <SortHeader column={column} label="Severity" />,
    sortingFn: (a, b) =>
      severityOrder[a.original.severity] - severityOrder[b.original.severity],
    cell: ({ row }) => <SeverityBadge value={row.original.severity} />,
  },
  {
    accessorKey: "question",
    header: "Question",
    cell: ({ row }) => (
      <span className="block max-w-[320px] truncate" title={row.original.question}>
        {row.original.question || <span className="text-muted-foreground">(empty)</span>}
      </span>
    ),
  },
  {
    accessorKey: "confidence",
    header: "Conf.",
    cell: ({ row }) =>
      row.original.confidence ? (
        <ConfidenceBadge value={row.original.confidence} />
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    accessorKey: "durationMs",
    header: ({ column }) => <SortHeader column={column} label="Latency" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatNumber(row.original.durationMs)} ms
      </span>
    ),
  },
  {
    accessorKey: "totalTokens",
    header: ({ column }) => <SortHeader column={column} label="Tokens" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatNumber(row.original.totalTokens)}
      </span>
    ),
  },
  {
    id: "flags",
    header: "Flags",
    enableSorting: false,
    cell: ({ row }) => {
      const { cohortViolation, injectionDetected } = row.original;
      if (!cohortViolation && !injectionDetected) {
        return <span className="text-muted-foreground">—</span>;
      }
      return (
        <div className={cn("flex items-center gap-1.5")}>
          {cohortViolation && (
            <span title="Cohort violation" className="text-[#b3344a]">
              <ShieldAlert className="size-4" />
            </span>
          )}
          {injectionDetected && (
            <span title="Injection detected" className="text-[#a35f00]">
              <TriangleAlert className="size-4" />
            </span>
          )}
        </div>
      );
    },
  },
];
