// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

/**
 * MessageMetadataPills
 *
 * Compact pill bar shown under an assistant message when "detailed view" is on.
 * Surfaces the per-message telemetry merged by the conversations API from
 * pipeline_traces: model + provider, input/cache/output tokens (each with its
 * USD cost), total cost, turn latency, sampling temperature, extended-thinking
 * flag, and reasoning / tool-step counts.
 *
 * Colour identifies the *category* of information (not the value): identity =
 * indigo, cost = emerald, latency = sky, config = amber, processing = violet.
 * The colour lives in the pill icon; every pill sits on a solid `bg-background`
 * so it contrasts with the muted message bubble. The provider carries a
 * per-vendor colour dot so the AI vendor is recognisable at a glance.
 *
 * Renders nothing for user/system messages or when no telemetry is available.
 */

import { Cpu, ArrowDown, ArrowUp, Zap, Database, Coins, Wrench, Brain, Timer, Thermometer, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import type { ConversationMessage, ReasoningDetail } from "@/lib/api";

// Per-category icon colour. Colour = kind of information, never the value.
const CATEGORY = {
  identity: "text-indigo-600 dark:text-indigo-400",
  cost: "text-emerald-600 dark:text-emerald-400",
  latency: "text-sky-600 dark:text-sky-400",
  config: "text-amber-600 dark:text-amber-400",
  processing: "text-violet-600 dark:text-violet-400",
} as const;

// Per-provider dot colour. Bounded set → categorical brand hint, not decoration.
const PROVIDER_DOT: Record<string, string> = {
  anthropic: "bg-orange-500",
  openai: "bg-emerald-500",
  bedrock: "bg-amber-500",
  nebius: "bg-sky-500",
  google: "bg-blue-500",
  gemini: "bg-blue-500",
};

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

function Pill({
  iconColor,
  icon: Icon,
  title,
  emphasis,
  children,
}: {
  iconColor: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  emphasis?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 border-border bg-background tabular-nums", emphasis ? "font-medium" : "font-normal")}
      title={title}
    >
      <Icon className={iconColor} />
      {children}
    </Badge>
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

  const sub = (text: string) => <span className="text-muted-foreground">· {text}</span>;
  const providerKey = message.provider?.toLowerCase() ?? "";
  const dotClass = PROVIDER_DOT[providerKey] ?? "bg-muted-foreground";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {message.model && (
        <Pill iconColor={CATEGORY.identity} icon={Cpu} title={t("conversations.detail.pills.model")}>
          <span className="font-mono">{message.model}</span>
        </Pill>
      )}

      {message.provider && (
        <Badge
          variant="outline"
          className="gap-1.5 border-border bg-background font-normal"
          title={t("conversations.detail.pills.provider")}
        >
          <span className={cn("size-1.5 rounded-full", dotClass)} />
          {message.provider}
        </Badge>
      )}

      <Pill iconColor={CATEGORY.cost} icon={ArrowDown} title={t("conversations.detail.pills.input")}>
        {regularInput.toLocaleString()}
        {hasCost && sub(formatCost(cost.input))}
      </Pill>

      {cacheRead > 0 && (
        <Pill iconColor={CATEGORY.cost} icon={Zap} title={t("conversations.detail.pills.cacheRead")}>
          {cacheRead.toLocaleString()}
          {hasCost && cost.cacheRead != null && sub(formatCost(cost.cacheRead))}
        </Pill>
      )}

      {cacheWrite > 0 && (
        <Pill iconColor={CATEGORY.cost} icon={Database} title={t("conversations.detail.pills.cacheWrite")}>
          {cacheWrite.toLocaleString()}
          {hasCost && cost.cacheWrite != null && sub(formatCost(cost.cacheWrite))}
        </Pill>
      )}

      <Pill iconColor={CATEGORY.cost} icon={ArrowUp} title={t("conversations.detail.pills.output")}>
        {completionTokens.toLocaleString()}
        {hasCost && sub(formatCost(cost.output))}
      </Pill>

      {hasCost && (
        <Pill iconColor={CATEGORY.cost} icon={Coins} title={t("conversations.detail.pills.total")} emphasis>
          {formatCost(cost.total)}
        </Pill>
      )}

      {lat?.totalMs != null && (
        <Pill
          iconColor={CATEGORY.latency}
          icon={Timer}
          title={[
            lat.ttfbMs != null ? `TTFB ${formatMs(lat.ttfbMs)}` : null,
            lat.llmCallMs != null ? `LLM ${formatMs(lat.llmCallMs)}` : null,
            lat.contextPrepMs != null ? `${t("conversations.detail.pills.contextPrep")} ${formatMs(lat.contextPrepMs)}` : null,
            lat.toolBuildingMs != null ? `${t("conversations.detail.pills.toolBuilding")} ${formatMs(lat.toolBuildingMs)}` : null,
          ].filter(Boolean).join(" · ") || t("conversations.detail.pills.latency")}
        >
          {formatMs(lat.totalMs)}
        </Pill>
      )}

      {message.temperature != null && (
        <Pill iconColor={CATEGORY.config} icon={Thermometer} title={t("conversations.detail.pills.temperature")}>
          {message.temperature}
        </Pill>
      )}

      {message.thinking && (
        <Pill iconColor={CATEGORY.config} icon={Sparkles} title={t("conversations.detail.pills.thinking")}>
          {t("conversations.detail.pills.thinking")}
        </Pill>
      )}

      {reasoningLen > 0 && (
        <Pill iconColor={CATEGORY.processing} icon={Brain} title={t("conversations.detail.pills.reasoning")}>
          {reasoningLen.toLocaleString()}
        </Pill>
      )}

      {toolCount > 0 && (
        <Pill iconColor={CATEGORY.processing} icon={Wrench} title={t("conversations.detail.pills.tools")}>
          {toolCount}
          {stepCount > 0 && sub(t("conversations.detail.pills.steps", { count: stepCount }))}
        </Pill>
      )}
    </div>
  );
}
