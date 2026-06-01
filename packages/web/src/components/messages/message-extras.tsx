// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

/**
 * MessageExtras
 *
 * Renders two collapsible panels above an assistant message bubble:
 *   1. Reasoning — model thinking/reasoning content (when present).
 *   2. Steps     — multi-step tool loop (one entry per step, with tool calls
 *                  + results + timing).
 *
 * Each panel is shown only when there's data to display; both panels are
 * absent for plain user/system messages or assistant messages without tools
 * and without reasoning.
 *
 * Props:
 *   - reasoning  Persisted message-level reasoning blocks (signed thinking
 *                blocks for Anthropic, summary text for OpenAI).
 *   - steps      Per-step trace produced by the multi-step LLM loop.
 *   - defaultOpen Default open state for both panels:
 *                  - playground (live chat) → false (clean UX)
 *                  - conversations (audit)  → true  (exploratory UX)
 */

import { useI18n } from "@/lib/i18n/context";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { ReasoningDetail, StepDetail } from "@/lib/api";
import { ChevronDown, BrainIcon, ListOrdered } from "lucide-react";

export interface LiveStepLike {
  index: number;
  stepType: string;
  text: string;
  toolCalls: { toolCallId: string; toolName: string; args: unknown }[];
  toolResults?: { toolCallId: string; result: unknown }[];
  finishReason?: string;
  durationMs?: number;
  legacy?: boolean;
}

export interface MessageExtrasProps {
  reasoning?: ReasoningDetail[] | null;
  steps?: StepDetail[] | LiveStepLike[] | null;
  defaultOpen?: boolean;
}

function jsonPreview(value: unknown): string {
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function findResultFor(step: LiveStepLike, toolCallId: string): unknown {
  return step.toolResults?.find((r) => r.toolCallId === toolCallId)?.result;
}

export function MessageExtras({
  reasoning,
  steps,
  defaultOpen = false,
}: MessageExtrasProps) {
  const { t } = useI18n();

  const hasReasoning = !!reasoning && reasoning.length > 0;
  // Hide steps with no tool calls: the Vercel AI SDK always emits a terminal
  // text-only step whose content is already shown in the message bubble (and
  // single-turn no-tool messages produce exactly one such empty step). The
  // panel is only useful for tool-using rounds, so we filter to those.
  const visibleSteps = (steps ?? []).filter((s) => s.toolCalls.length > 0);
  const hasSteps = visibleSteps.length > 0;

  if (!hasReasoning && !hasSteps) return null;

  return (
    <div className="mb-2 flex flex-col gap-2">
      {hasReasoning && (
        <Collapsible defaultOpen={defaultOpen}>
          <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted">
            <BrainIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">{t("message.reasoning.label")}</span>
            <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-t-0 bg-muted/30 px-3 py-2 text-xs">
            <div className="flex flex-col gap-2 whitespace-pre-wrap font-mono leading-relaxed">
              {reasoning!.map((r, i) =>
                r.type === "text" ? (
                  <p key={i} className="text-foreground/80">
                    {r.text}
                  </p>
                ) : (
                  <p key={i} className="italic text-muted-foreground">
                    [{t("message.reasoning.redacted")}]
                  </p>
                ),
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {hasSteps && (
        <Collapsible defaultOpen={defaultOpen}>
          <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted">
            <ListOrdered className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">
              {t("message.steps.label", { count: visibleSteps.length })}
            </span>
            <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-t-0 bg-muted/30 px-3 py-2 text-xs">
            <Accordion type="multiple" className="w-full">
              {visibleSteps.map((step) => {
                const totalCalls = step.toolCalls.length;
                return (
                  <AccordionItem
                    key={step.index}
                    value={String(step.index)}
                    className="border-b last:border-0"
                  >
                    <AccordionTrigger className="py-2 hover:no-underline">
                      <span className="flex items-center gap-2 text-xs">
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono">
                          #{step.index + 1}
                        </span>
                        <span>
                          {t("message.steps.stepLine", {
                            type: step.stepType,
                            calls: totalCalls,
                          })}
                        </span>
                        {step.legacy && (
                          <span className="rounded bg-muted-foreground/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {t("message.steps.legacy")}
                          </span>
                        )}
                        {typeof step.durationMs === "number" && step.durationMs > 0 && (
                          <span className="text-muted-foreground">
                            {t("message.steps.duration", { ms: step.durationMs })}
                          </span>
                        )}
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-2 pb-2 pt-1">
                      {step.text && (
                        <div className="text-foreground/80">{step.text}</div>
                      )}
                      {step.toolCalls.map((tc) => {
                        const result = findResultFor(step, tc.toolCallId);
                        return (
                          <div
                            key={tc.toolCallId}
                            className="rounded border bg-background/50 p-2"
                          >
                            <div className="mb-1 font-mono font-semibold">
                              {tc.toolName}
                            </div>
                            <div className="mb-1 text-muted-foreground">
                              {t("message.steps.args")}
                            </div>
                            <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
                              {jsonPreview(tc.args)}
                            </pre>
                            <div className="mb-1 mt-2 text-muted-foreground">
                              {t("message.steps.result")}
                            </div>
                            <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
                              {jsonPreview(result)}
                            </pre>
                          </div>
                        );
                      })}
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
