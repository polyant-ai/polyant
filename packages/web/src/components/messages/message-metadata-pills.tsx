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
 * Colour is semantic, not decorative: the total cost is the accent headline,
 * cache (savings) is emerald, latency turns red only when the turn was slow,
 * extended thinking is amber; everything else stays neutral. The provider gets
 * a small colour dot so the AI vendor is recognisable at a glance.
 *
 * Renders nothing for user/system messages or when no telemetry is available.
 */

import { Cpu, ArrowDown, ArrowUp, Zap, Coins, Wrench, Brain, Timer, Thermometer, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import type { ConversationMessage, ReasoningDetail } from "@/lib/api";

type Tone = "neutral" | "good" | "notable" | "bad" | "headline";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border text-foreground",
  good: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  notable: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  bad: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  headline: "border-transparent bg-accent text-accent-foreground",
};

// Per-provider dot colour. Bounded set → categorical brand hint, not decoration.
const PROVIDER_DOT: Record<string, string> = {
  anthropic: "bg-orange-500",
  openai: "bg-emerald-500",
  bedrock: "bg-amber-500",
  nebius: "bg-sky-500",
  google: "bg-blue-500",
  gemini: "bg-blue-500",
};

// Latency thresholds (ms): fast turns read green, genuinely slow ones red.
const LATENCY_FAST_MS = 3000;
const LATENCY_SLOW_MS = 15000;

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
  tone = "neutral",
  icon: Icon,
  title,
  children,
}: {
  tone?: Tone;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal tabular-nums", TONE_CLASS[tone])} title={title}>
      <Icon className={tone === "neutral" ? "text-muted-foreground" : "opacity-70"} />
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

  const sub = (text: string) => <span className="opacity-70">· {text}</span>;

  const latencyTone: Tone =
    lat?.totalMs == null
      ? "neutral"
      : lat.totalMs < LATENCY_FAST_MS
        ? "good"
        : lat.totalMs > LATENCY_SLOW_MS
          ? "bad"
          : "neutral";

  const providerKey = message.provider?.toLowerCase() ?? "";
  const dotClass = PROVIDER_DOT[providerKey] ?? "bg-muted-foreground";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {message.model && (
        <Pill tone="neutral" icon={Cpu} title={t("conversations.detail.pills.model")}>
          <span className="font-mono">{message.model}</span>
        </Pill>
      )}

      {message.provider && (
        <Badge
          variant="outline"
          className="gap-1.5 border-border font-normal"
          title={t("conversations.detail.pills.provider")}
        >
          <span className={cn("size-1.5 rounded-full", dotClass)} />
          {message.provider}
        </Badge>
      )}

      <Pill tone="neutral" icon={ArrowDown} title={t("conversations.detail.pills.input")}>
        {regularInput.toLocaleString()}
        {hasCost && sub(formatCost(cost.input))}
      </Pill>

      {cacheTokens > 0 && (
        <Pill tone="good" icon={Zap} title={t("conversations.detail.pills.cache")}>
          {cacheTokens.toLocaleString()}
          {hasCost && sub(formatCost(cost.cache))}
        </Pill>
      )}

      <Pill tone="neutral" icon={ArrowUp} title={t("conversations.detail.pills.output")}>
        {completionTokens.toLocaleString()}
        {hasCost && sub(formatCost(cost.output))}
      </Pill>

      {hasCost && (
        <Pill tone="headline" icon={Coins} title={t("conversations.detail.pills.total")}>
          {formatCost(cost.total)}
        </Pill>
      )}

      {lat?.totalMs != null && (
        <Pill
          tone={latencyTone}
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
        <Pill tone="neutral" icon={Thermometer} title={t("conversations.detail.pills.temperature")}>
          {message.temperature}
        </Pill>
      )}

      {message.thinking && (
        <Pill tone="notable" icon={Sparkles} title={t("conversations.detail.pills.thinking")}>
          {t("conversations.detail.pills.thinking")}
        </Pill>
      )}

      {reasoningLen > 0 && (
        <Pill tone="neutral" icon={Brain} title={t("conversations.detail.pills.reasoning")}>
          {reasoningLen.toLocaleString()}
        </Pill>
      )}

      {toolCount > 0 && (
        <Pill tone="neutral" icon={Wrench} title={t("conversations.detail.pills.tools")}>
          {toolCount}
          {stepCount > 0 && sub(t("conversations.detail.pills.steps", { count: stepCount }))}
        </Pill>
      )}
    </div>
  );
}
