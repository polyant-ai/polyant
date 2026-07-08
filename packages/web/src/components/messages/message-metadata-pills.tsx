// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

/**
 * MessageMetadataPills
 *
 * Compact pill bar shown under an assistant message when "detailed view" is on.
 * Surfaces the per-message telemetry merged by the conversations API from
 * pipeline_traces: model, input/cache/output tokens (each with its USD cost),
 * total cost, turn latency, sampling temperature, extended-thinking flag, and
 * reasoning / tool-step counts.
 *
 * Renders nothing for user/system messages or when no telemetry is available.
 */

import { Cpu, ArrowDown, ArrowUp, Zap, Coins, Wrench, Brain, Timer, Thermometer, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n/context";
import type { ConversationMessage, ReasoningDetail } from "@/lib/api";

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function reasoningChars(reasoning: ReasoningDetail[] | null | undefined): number {
  if (!reasoning) return 0;
  return reasoning.reduce(
    (n, r) => n + (r.type === "text" ? r.text.length : r.data.length),
    0,
  );
}

export function MessageMetadataPills({ message }: { message: ConversationMessage }) {
  const { t } = useI18n();

  if (message.role !== "assistant") return null;

  const promptTokens = message.promptTokens ?? 0;
  const completionTokens = message.completionTokens ?? 0;
  const cacheRead = message.cachedInputTokens ?? 0;
  const cacheWrite = message.cacheCreationInputTokens ?? 0;
  const cacheTokens = cacheRead + cacheWrite;
  const regularInput = Math.max(0, promptTokens - cacheTokens);
  const cost = message.cost;
  const hasCost = !!cost && cost.total > 0;
  const lat = message.latency;

  const toolCount =
    message.steps?.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0) ?? 0;
  const stepCount = message.steps?.length ?? 0;
  const reasoningLen = reasoningChars(message.reasoning);

  // No telemetry at all (legacy row) → don't render an empty bar.
  if (promptTokens === 0 && completionTokens === 0 && !message.model) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {message.model && (
        <Badge
          variant="outline"
          className="gap-1 font-normal"
          title={message.provider ? `${t("conversations.detail.pills.model")} · ${message.provider}` : t("conversations.detail.pills.model")}
        >
          <Cpu className="text-muted-foreground" />
          <span className="font-mono">{message.model}</span>
        </Badge>
      )}

      <Badge variant="secondary" className="gap-1 font-normal tabular-nums" title={t("conversations.detail.pills.input")}>
        <ArrowDown className="text-muted-foreground" />
        {regularInput.toLocaleString()}
        {hasCost && <span className="text-muted-foreground">· {formatCost(cost.input)}</span>}
      </Badge>

      {cacheTokens > 0 && (
        <Badge variant="secondary" className="gap-1 font-normal tabular-nums" title={t("conversations.detail.pills.cache")}>
          <Zap className="text-muted-foreground" />
          {cacheTokens.toLocaleString()}
          {hasCost && <span className="text-muted-foreground">· {formatCost(cost.cache)}</span>}
        </Badge>
      )}

      <Badge variant="secondary" className="gap-1 font-normal tabular-nums" title={t("conversations.detail.pills.output")}>
        <ArrowUp className="text-muted-foreground" />
        {completionTokens.toLocaleString()}
        {hasCost && <span className="text-muted-foreground">· {formatCost(cost.output)}</span>}
      </Badge>

      {hasCost && (
        <Badge variant="secondary" className="gap-1 tabular-nums" title={t("conversations.detail.pills.total")}>
          <Coins className="text-muted-foreground" />
          {formatCost(cost.total)}
        </Badge>
      )}

      {lat?.totalMs != null && (
        <Badge
          variant="outline"
          className="gap-1 font-normal tabular-nums"
          title={[
            lat.ttfbMs != null ? `TTFB ${formatMs(lat.ttfbMs)}` : null,
            lat.llmCallMs != null ? `LLM ${formatMs(lat.llmCallMs)}` : null,
            lat.contextPrepMs != null ? `${t("conversations.detail.pills.contextPrep")} ${formatMs(lat.contextPrepMs)}` : null,
            lat.toolBuildingMs != null ? `${t("conversations.detail.pills.toolBuilding")} ${formatMs(lat.toolBuildingMs)}` : null,
          ].filter(Boolean).join(" · ") || t("conversations.detail.pills.latency")}
        >
          <Timer className="text-muted-foreground" />
          {formatMs(lat.totalMs)}
        </Badge>
      )}

      {message.temperature != null && (
        <Badge variant="outline" className="gap-1 font-normal tabular-nums" title={t("conversations.detail.pills.temperature")}>
          <Thermometer className="text-muted-foreground" />
          {message.temperature}
        </Badge>
      )}

      {message.thinking && (
        <Badge variant="outline" className="gap-1 font-normal" title={t("conversations.detail.pills.thinking")}>
          <Sparkles className="text-muted-foreground" />
          {t("conversations.detail.pills.thinking")}
        </Badge>
      )}

      {reasoningLen > 0 && (
        <Badge variant="outline" className="gap-1 font-normal tabular-nums" title={t("conversations.detail.pills.reasoning")}>
          <Brain className="text-muted-foreground" />
          {reasoningLen.toLocaleString()}
        </Badge>
      )}

      {toolCount > 0 && (
        <Badge variant="outline" className="gap-1 font-normal tabular-nums" title={t("conversations.detail.pills.tools")}>
          <Wrench className="text-muted-foreground" />
          {toolCount}
          {stepCount > 0 && <span className="text-muted-foreground">· {t("conversations.detail.pills.steps", { count: stepCount })}</span>}
        </Badge>
      )}
    </div>
  );
}
