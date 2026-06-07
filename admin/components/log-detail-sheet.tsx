"use client";

import type { ReactNode } from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { RequestLog } from "@/lib/types";
import {
  CategoryBadge,
  ConfidenceBadge,
  GroupBadge,
  OutcomeBadge,
  SeverityBadge,
  VariantBadge,
} from "./status-badges";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        "rounded-md bg-secondary px-1.5 py-0.5 font-mono text-xs break-all text-foreground",
        className,
      )}
    >
      {children}
    </code>
  );
}

function FlagBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs",
        on
          ? "border-transparent bg-[#e06070]/12 font-medium text-[#b3344a]"
          : "border-border text-muted-foreground",
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", on ? "bg-[#e06070]" : "bg-muted-foreground/40")}
      />
      {label}: {on ? "yes" : "no"}
    </span>
  );
}

function TokenStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl bg-card px-3 py-2 ring-1 ring-foreground/10">
      <div className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="font-mono text-sm">{formatNumber(value)}</div>
    </div>
  );
}

export function LogDetailSheet({
  log,
  open,
  onOpenChange,
}: {
  log: RequestLog | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 data-[side=right]:sm:max-w-xl"
      >
        {log && (
          <>
            <SheetHeader className="shrink-0 gap-2 border-b border-border p-5">
              <div className="flex flex-wrap items-center gap-2">
                <OutcomeBadge value={log.outcome} />
                <SeverityBadge value={log.severity} />
                <GroupBadge value={log.group} />
                <VariantBadge value={log.variant} />
                {log.category && <CategoryBadge value={log.category} />}
                {log.agent && <Mono>{log.agent}</Mono>}
              </div>
              <SheetTitle className="pr-8 text-base leading-snug">
                {log.question || "(empty question)"}
              </SheetTitle>
              <SheetDescription asChild>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{formatDateTime(log.createdAt)}</span>
                  <span aria-hidden>·</span>
                  <span>{formatNumber(log.durationMs)} ms</span>
                  <span aria-hidden>·</span>
                  <Mono className="bg-transparent px-0">{log.traceId}</Mono>
                </div>
              </SheetDescription>
            </SheetHeader>

            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-5 p-5">
                {log.answer && (
                  <Section title="Answer">
                    <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                      {log.answer}
                    </p>
                    {log.confidence && (
                      <div className="pt-1">
                        <ConfidenceBadge value={log.confidence} />
                      </div>
                    )}
                  </Section>
                )}

                {(log.extractionReasoning || log.answerReasoning) && (
                  <Section title="Reasoning">
                    <div className="space-y-3">
                      {log.extractionReasoning && (
                        <div>
                          <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                            Extraction (find-patient)
                          </div>
                          <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                            {log.extractionReasoning}
                          </p>
                        </div>
                      )}
                      {log.answerReasoning && (
                        <div>
                          <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                            Answer (answer-patient)
                          </div>
                          <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                            {log.answerReasoning}
                          </p>
                        </div>
                      )}
                    </div>
                  </Section>
                )}

                {log.history && log.history.length > 0 && (
                  <Section title="Conversation history">
                    <div className="space-y-2">
                      {log.history.map((turn, i) => (
                        <div
                          key={i}
                          className={cn(
                            "rounded-xl px-3 py-2 text-sm",
                            turn.role === "user"
                              ? "bg-secondary text-foreground"
                              : "bg-card text-foreground ring-1 ring-foreground/10",
                          )}
                        >
                          <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                            {turn.role}
                          </div>
                          <div className="whitespace-pre-wrap">{turn.content}</div>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}

                <Section title="Retrieval">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                    <dt className="text-muted-foreground">Path</dt>
                    <dd>
                      <Mono>{log.retrievalPath}</Mono>
                    </dd>
                    <dt className="text-muted-foreground">Patient</dt>
                    <dd>
                      {log.resolvedPatientId ? (
                        <Mono>{log.resolvedPatientId}</Mono>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </dd>
                  </dl>
                  {log.recordsRetrieved && log.recordsRetrieved.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {log.recordsRetrieved.map((ref, i) => (
                        <Mono key={i}>
                          {ref.table}:{ref.id}
                        </Mono>
                      ))}
                    </div>
                  )}
                  {log.citations && log.citations.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <span className="text-xs text-muted-foreground">Citations</span>
                      {log.citations.map((c, i) => (
                        <Mono key={i}>{c}</Mono>
                      ))}
                    </div>
                  )}
                </Section>

                <Section title="Security">
                  <div className="flex flex-wrap gap-2">
                    <FlagBadge label="Fallback used" on={log.fallbackUsed} />
                    <FlagBadge label="Injection detected" on={log.injectionDetected} />
                    <FlagBadge label="Cohort violation" on={log.cohortViolation} />
                  </div>
                </Section>

                <Section title="Tokens">
                  <dl className="grid grid-cols-3 gap-2">
                    <TokenStat label="Input" value={log.inputTokens} />
                    <TokenStat label="Output" value={log.outputTokens} />
                    <TokenStat label="Total" value={log.totalTokens} />
                  </dl>
                </Section>

                {log.rawModelOutput && (
                  <Section title="Raw model output">
                    <pre className="max-h-72 overflow-auto rounded-xl bg-secondary p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
                      {log.rawModelOutput}
                    </pre>
                  </Section>
                )}
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
