"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  AgentVariant,
  CohortGroup,
  Confidence,
  Outcome,
  Severity,
} from "@/lib/types";

// Brand-tinted status badges, reused by the table and the detail sheet. Colors come from
// the CareBrain palette (periwinkle / indigo / status green-orange-red). `variant="outline"`
// gives the neutral chip base; the per-value classes override bg/text/border.

const outcomeClass: Record<Outcome, string> = {
  answered: "bg-[#8f8cff]/15 text-[#5b58cf]",
  patients_found: "bg-[#8f8cff]/15 text-[#5b58cf]",
  no_match: "bg-muted text-muted-foreground",
  not_answerable: "bg-muted text-muted-foreground",
  cohort_violation: "bg-[#e06070]/15 text-[#b3344a]",
  injection_refused: "bg-[#e06070]/15 text-[#b3344a]",
  error: "bg-[#ff9500]/15 text-[#a35f00]",
};

const outcomeLabel: Record<Outcome, string> = {
  answered: "Answered",
  patients_found: "Patients found",
  no_match: "No match",
  not_answerable: "Not answerable",
  cohort_violation: "Cohort violation",
  injection_refused: "Injection refused",
  error: "Error",
};

export function OutcomeBadge({
  value,
  className,
}: {
  value: Outcome;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent font-medium", outcomeClass[value], className)}
    >
      {outcomeLabel[value] ?? value}
    </Badge>
  );
}

const severityClass: Record<Severity, string> = {
  none: "bg-muted text-muted-foreground",
  low: "bg-[#30b0c7]/15 text-[#1d7e90]",
  medium: "bg-[#ff9500]/18 text-[#a35f00]",
  high: "bg-[#e06070]/18 text-[#b3344a]",
};

export function SeverityBadge({
  value,
  className,
}: {
  value: Severity;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-transparent font-medium capitalize",
        severityClass[value],
        className,
      )}
    >
      {value}
    </Badge>
  );
}

const confidenceClass: Record<Confidence, string> = {
  High: "bg-[#34c759]/15 text-[#1f8f3d]",
  Medium: "bg-[#ff9500]/18 text-[#a35f00]",
  Low: "bg-[#e06070]/18 text-[#b3344a]",
};

export function ConfidenceBadge({
  value,
  className,
}: {
  value: Confidence;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent font-medium", confidenceClass[value], className)}
    >
      {value}
    </Badge>
  );
}

const groupClass: Record<CohortGroup, string> = {
  A: "bg-[#8f8cff]/15 text-[#5b58cf]",
  B: "bg-[#4f46e5]/12 text-[#4338ca]",
};

export function GroupBadge({
  value,
  className,
}: {
  value: CohortGroup;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent font-semibold", groupClass[value], className)}
    >
      {value}
    </Badge>
  );
}

// A/B experiment arm. Teal = the structured-output control; amber = the tool-calling variant —
// distinct hues from the cohort badge so the two dimensions don't read as the same thing.
const variantClass: Record<AgentVariant, string> = {
  structured: "bg-[#30b0c7]/15 text-[#1d7e90]",
  tool_calling: "bg-[#ff9500]/15 text-[#a35f00]",
};

const variantLabel: Record<AgentVariant, string> = {
  structured: "Structured",
  tool_calling: "Tool-calling",
};

export function VariantBadge({
  value,
  className,
}: {
  value: AgentVariant | null;
  className?: string;
}) {
  if (!value) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent font-medium", variantClass[value], className)}
    >
      {variantLabel[value] ?? value}
    </Badge>
  );
}
