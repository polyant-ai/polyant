// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Brain, CheckCircle2, Wrench, XCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ActivityRow } from "./activity-row";
import { useI18n } from "@/lib/i18n/context";
import type { ReasoningDetail, StepDetail } from "@/lib/api";

export interface LiveStepLike {
  index: number;
  stepType: string;
  text: string;
  toolCalls: { toolCallId: string; toolName: string; args: unknown }[];
  toolResults?: { toolCallId: string; result: unknown }[];
  legacy?: boolean;
}

export interface MessageExtrasProps {
  reasoning?: ReasoningDetail[] | null;
  steps?: StepDetail[] | LiveStepLike[] | null;
}

function jsonPreview(value: unknown): string {
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isFailedResult(result: unknown): boolean {
  return result instanceof Error || (typeof result === "object" && result !== null &&
    (("isError" in result && result.isError === true) ||
      ("success" in result && result.success === false) ||
      ("error" in result && typeof result.error === "string" && result.error.length > 0)));
}

export function MessageExtras({ reasoning, steps }: MessageExtrasProps) {
  const { t } = useI18n();
  const calls = (steps ?? []).flatMap((step) => step.toolCalls.map((call) => ({ step, call })));
  if (!reasoning?.length && !calls.length) return null;

  return (
    <div className="mb-3 border-l border-border pl-3">
      {reasoning && reasoning.length > 0 && (
        <ActivityRow
          icon={<Brain className="size-3.5" />}
          iconLabel={t("message.reasoning.label")}
          tone="reasoning"
          detail={<div className="space-y-2 whitespace-pre-wrap break-words leading-relaxed">
            {reasoning.map((block, index) => (
              <div key={index} className="prose-sm max-w-none">
                {block.type === "text" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown> : `[${t("message.reasoning.redacted")}]`}
              </div>
            ))}
          </div>}
        >
          {t("message.reasoning.label")}
        </ActivityRow>
      )}
      {calls.map(({ step, call }) => {
        const result = step.toolResults?.find((item) => item.toolCallId === call.toolCallId)?.result;
        const hasResult = step.toolResults?.some((item) => item.toolCallId === call.toolCallId);
        return (
          <ActivityRow
            key={`${step.index}-${call.toolCallId}`}
            icon={<Wrench className="size-3.5" />}
            iconLabel={t("message.activity.tool")}
            tone="tool"
            status={hasResult ? isFailedResult(result) ? (
              <XCircle className="size-4 shrink-0 text-destructive" aria-label={t("message.activity.failed")} />
            ) : (
              <CheckCircle2 className="size-4 shrink-0 text-success" aria-label={t("message.activity.succeeded")} />
            ) : undefined}
            detail={<div className="space-y-2">
              {step.text && <p className="whitespace-pre-wrap break-words">{step.text}</p>}
              <div>
                <p className="mb-1 font-medium">{t("message.steps.args")}</p>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs text-foreground">{jsonPreview(call.args)}</pre>
              </div>
              {hasResult && <div>
                <p className="mb-1 font-medium">{t("message.steps.result")}</p>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs text-foreground">{jsonPreview(result)}</pre>
              </div>}
            </div>}
          >
            {t("message.activity.called")} <code className="rounded bg-muted px-1 py-0.5 font-semibold">{call.toolName}</code>
          </ActivityRow>
        );
      })}
    </div>
  );
}
