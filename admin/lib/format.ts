// Small display formatters shared across the table and the detail sheet.

/** Compact local date-time, e.g. "Jun 5, 14:30:22". Returns "—" for bad input. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Thousands-separated number, or "—" when null/undefined. */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString();
}
