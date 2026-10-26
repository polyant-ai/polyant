// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

/**
 * DebugSheet
 *
 * Right-side panel that shows, for a single assistant turn, everything exchanged
 * with the AI API, one tab per part: usage, the system prompt, the tool
 * definitions, the history (the messages array sent), the per-step tool I/O
 * timeline, and the conversation state the model read.
 *
 * The heavy payload is fetched on-demand (on open) via the per-message debug
 * endpoint, so the message list stays light. The payload is only present when the
 * instance had DEBUG mode on at generation time; otherwise only the step trace is
 * shown with a notice.
 *
 * Shared by the playground and the conversation-detail page — both pass a
 * conversationId + the DB message id + the instance slug.
 */

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import { api } from "@/lib/api";
import type { CostBreakdown, MessageDebug, MessageLatency, TurnModelCall } from "@/lib/api";
import { Check, Copy, Cpu } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useResource } from "@/hooks/use-resource";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { MessageExtras } from "./message-extras";
import { JsonTree } from "./json-tree";
import { extractTurnState } from "./turn-state";
import { ChipTabs, type ChipTab } from "@/components/layout/chip-tabs";
import { useFormat } from "@/lib/use-format";

export interface DebugSheetTarget {
  conversationId: string;
  messageId: string;
  instanceId: string;
  /** Per-message telemetry (passed from the message list — no extra fetch). */
  model?: string | null;
  provider?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cost?: CostBreakdown | null;
  thinking?: boolean | null;
  temperature?: number | null;
  latency?: MessageLatency | null;
}

export interface DebugSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Target message to inspect. Null while no message is selected. */
  target: DebugSheetTarget | null;
}

/**
 * Model + token/cost breakdown for the turn, from the target metadata, then how
 * the turn arrived and the model calls it made, from the loaded debug data.
 */
function UsageSection({ target, debug }: { target: DebugSheetTarget; debug: MessageDebug | null }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const prompt = target.promptTokens ?? 0;
  const completion = target.completionTokens ?? 0;
  const cacheRead = target.cachedInputTokens ?? 0;
  const cacheWrite = target.cacheCreationInputTokens ?? 0;
  const regularInput = Math.max(0, prompt - cacheRead - cacheWrite);
  const cost = target.cost;

  if (!target.model && prompt === 0 && completion === 0 && !debug?.turn && !debug?.modelCalls?.length) {
    return <p className="text-sm text-muted-foreground">—</p>;
  }

  const fmtCost = (usd: number | undefined) => (usd != null ? fmt.currency(usd) : "—");
  const rows: Array<{ label: string; tokens: number; cost: number | undefined }> = [
    { label: t("conversations.detail.pills.input"), tokens: regularInput, cost: cost?.input },
    ...(cacheRead > 0
      ? [{ label: t("conversations.detail.pills.cacheRead"), tokens: cacheRead, cost: cost?.cacheRead }]
      : []),
    ...(cacheWrite > 0
      ? [{ label: t("conversations.detail.pills.cacheWrite"), tokens: cacheWrite, cost: cost?.cacheWrite }]
      : []),
    { label: t("conversations.detail.pills.output"), tokens: completion, cost: cost?.output },
  ];

  return (
    <div className="flex flex-col gap-2">
      {target.model && (
        <div className="flex items-center gap-2 text-sm">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono">{target.model}</span>
          {target.provider && (
            <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
              {target.provider}
            </span>
          )}
        </div>
      )}
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-muted-foreground">
            <th className="py-1 text-left font-normal"></th>
            <th className="py-1 text-right font-normal">{t("message.debug.usageToken")}</th>
            <th className="py-1 text-right font-normal">{t("message.debug.usageCost")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t">
              <td className="py-1.5 text-muted-foreground">{r.label}</td>
              <td className="py-1.5 text-right">{fmt.number(r.tokens)}</td>
              <td className="py-1.5 text-right">{fmtCost(r.cost)}</td>
            </tr>
          ))}
          <tr className="border-t font-medium">
            <td className="py-1.5">{t("message.debug.usageTotal")}</td>
            <td className="py-1.5 text-right">{fmt.number(prompt + completion)}</td>
            <td className="py-1.5 text-right">{fmtCost(cost?.total)}</td>
          </tr>
        </tbody>
      </table>
      <DiagnosticsList target={target} turn={debug?.turn ?? null} />
      {debug?.modelCalls && debug.modelCalls.length > 0 && <ModelCalls calls={debug.modelCalls} />}
    </div>
  );
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** Latency breakdown, sampling knobs, and how the turn arrived (channel, streaming, voice). */
function DiagnosticsList({ target, turn }: { target: DebugSheetTarget; turn: MessageDebug["turn"] }) {
  const { t } = useI18n();
  const lat = target.latency;
  const rows: Array<{ label: string; value: string }> = [];

  if (lat) {
    if (lat.totalMs != null) rows.push({ label: t("message.debug.latencyTotal"), value: formatMs(lat.totalMs) });
    if (lat.ttfbMs != null) rows.push({ label: "TTFB", value: formatMs(lat.ttfbMs) });
    if (lat.llmCallMs != null) rows.push({ label: t("message.debug.latencyLlm"), value: formatMs(lat.llmCallMs) });
    if (lat.contextPrepMs != null) rows.push({ label: t("message.debug.latencyContextPrep"), value: formatMs(lat.contextPrepMs) });
    if (lat.toolBuildingMs != null) rows.push({ label: t("message.debug.latencyToolBuilding"), value: formatMs(lat.toolBuildingMs) });
  }
  if (target.temperature != null) rows.push({ label: t("conversations.detail.pills.temperature"), value: String(target.temperature) });
  if (target.thinking != null) {
    rows.push({
      label: t("conversations.detail.pills.thinking"),
      value: target.thinking ? t("message.debug.thinkingOn") : t("message.debug.thinkingOff"),
    });
  }

  if (turn) {
    rows.push({ label: t("message.debug.channel"), value: turn.channel });
    rows.push({
      label: t("message.debug.streaming"),
      value: turn.streaming ? t("message.debug.thinkingOn") : t("message.debug.thinkingOff"),
    });
    // Only a voice turn was transcribed.
    const stt = turn.speechToText;
    if (stt) {
      rows.push({ label: t("message.debug.sttProvider"), value: stt.provider });
      if (stt.audioDurationSec != null) rows.push({ label: t("message.debug.audioDuration"), value: formatMs(stt.audioDurationSec * 1000) });
      if (stt.durationMs != null) rows.push({ label: t("message.debug.sttDuration"), value: formatMs(stt.durationMs) });
    }
  }

  if (rows.length === 0) return null;

  return (
    <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between border-t py-1.5">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className="tabular-nums">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const CALL_TYPE_KEY: Record<string, TranslationKey> = {
  conversation: "message.debug.callConversation",
  service: "message.debug.callService",
  embedding: "message.debug.callEmbedding",
};
const OUTCOME: Record<string, { emoji: string; key: TranslationKey }> = {
  ok: { emoji: "✅", key: "message.debug.outcomeOk" },
  error: { emoji: "❌", key: "message.debug.outcomeError" },
  aborted: { emoji: "⏹️", key: "message.debug.outcomeAborted" },
};

/** Date and time of a call to the millisecond: calls of one turn can share the second. */
function callTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

/**
 * Every model call of the turn, in order: the answer and the service calls
 * around it (titles, memory, summaries), with the failure class of one that
 * did not return.
 */
function ModelCalls({ calls }: { calls: TurnModelCall[] }) {
  const { t, locale } = useI18n();
  const fmt = useFormat();
  return (
    <div className="mt-3 flex flex-col gap-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("message.debug.modelCalls")}</h3>
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-muted-foreground">
            <th className="py-1 text-left font-normal">{t("message.debug.callTime")}</th>
            <th className="py-1 text-left font-normal">{t("message.debug.callType")}</th>
            <th className="w-px py-1 text-left font-normal">{t("message.debug.callModel")}</th>
            <th className="py-1 text-right font-normal">{t("message.debug.callDuration")}</th>
            <th className="py-1 text-right font-normal">{t("message.debug.usageToken")}</th>
            <th className="py-1 text-right font-normal">{t("message.debug.usageCost")}</th>
            <th className="py-1 text-right font-normal">{t("message.debug.callOutcome")}</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call, i) => (
            <tr key={i} className="border-t align-top">
              <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                {callTime(call.createdAt, locale)}
              </td>
              <td className="py-1.5">{CALL_TYPE_KEY[call.callType] ? t(CALL_TYPE_KEY[call.callType]) : call.callType}</td>
              <td className="whitespace-nowrap py-1.5">
                <span className="font-mono">{call.model}</span>
                <span className="block text-xs text-muted-foreground">{call.provider}</span>
              </td>
              <td className="py-1.5 text-right">{formatMs(call.durationMs)}</td>
              <td className="py-1.5 text-right">
                {fmt.number(call.promptTokens)} / {fmt.number(call.completionTokens)}
              </td>
              <td className="py-1.5 text-right">{fmt.currency(call.costUsd)}</td>
              <td className="py-1.5 text-right">
                {OUTCOME[call.outcome] ? (
                  <span
                    role="img"
                    title={t(OUTCOME[call.outcome].key)}
                    aria-label={t(OUTCOME[call.outcome].key)}
                    className="saturate-50"
                  >
                    {OUTCOME[call.outcome].emoji}
                  </span>
                ) : (
                  call.outcome
                )}
                {call.errorKind && <span className="block text-xs text-destructive">{call.errorKind}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Copies the open tab's content, and says so for a moment afterwards. Disabled
 * while there is nothing to copy: the turn is loading or its payload was not
 * captured.
 */
function CopyTabButton({ text }: { text: string | undefined }) {
  const { t } = useI18n();
  const { copy, copied } = useCopyToClipboard(2000, t("message.debug.copyFailed"));
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      disabled={text === undefined}
      onClick={() => text !== undefined && void copy(text)}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? t("message.debug.copied") : t("common.copy")}
    </Button>
  );
}

/**
 * The sheet's content, mounted only while the sheet is open (the Radix content
 * unmounts on close), so each opening loads the turn afresh and none shows the
 * previous one's data while it does.
 */
function DebugSheetBody({ target }: { target: DebugSheetTarget }) {
  const { t } = useI18n();
  const { data = null, error, loading } = useResource(
    [target.conversationId, target.messageId, target.instanceId],
    () => api.conversations.messageDebug(target.conversationId, target.messageId, target.instanceId),
  );

  const [tab, setTab] = useState("usage");
  const payload = data?.debugPayload ?? null;
  const steps = data?.steps ?? [];
  const turnState = payload ? extractTurnState(payload.messages) : null;

  // The tabs that hold what the model read can be copied: the system prompt
  // as its text, the messages and the conversation state as raw JSON.
  const copies: Record<string, string | undefined> = {
    prompt: payload?.system || undefined,
    messages: payload ? JSON.stringify(payload.messages, null, 2) : undefined,
    context: turnState ? JSON.stringify(turnState, null, 2) : undefined,
  };
  const copyable = tab in copies;

  // The payload tabs wait for the fetch and say why they are empty; Usage is
  // drawn from the message list and is there from the first frame.
  const pending =
    loading ? (
      <p className="text-sm text-muted-foreground">{t("message.debug.loading")}</p>
    ) : error !== undefined || !data ? (
      <p className="text-sm text-destructive">{t("message.debug.error")}</p>
    ) : null;
  const noPayload = (
    <p className="rounded-md border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
      {t("message.debug.noPayload")}
    </p>
  );
  const none = <p className="text-sm text-muted-foreground">—</p>;

  const tabs: ChipTab[] = [
    {
      value: "usage",
      label: t("message.debug.usage"),
      children: <UsageSection target={target} debug={data} />,
    },
    {
      value: "prompt",
      label: t("message.debug.prompt"),
      children:
        pending ??
        (payload ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-[13px] leading-relaxed">
            {payload.system || "—"}
          </pre>
        ) : (
          noPayload
        )),
    },
    {
      value: "tools",
      label: t("message.debug.tools"),
      count: payload?.tools.length,
      children:
        pending ??
        (!payload ? (
          noPayload
        ) : payload.tools.length === 0 ? (
          none
        ) : (
          <ul className="divide-y">
            {payload.tools.map((tool) => (
              <li key={tool.name} className="py-2.5 first:pt-0">
                <span className="font-mono text-sm">{tool.name}</span>
                {tool.description && (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{tool.description}</p>
                )}
              </li>
            ))}
          </ul>
        )),
    },
    {
      value: "messages",
      label: t("message.debug.messages"),
      count: payload?.messages.length,
      children: pending ?? (payload ? <JsonTree value={payload.messages} /> : noPayload),
    },
    {
      value: "steps",
      label: t("message.debug.steps"),
      count: data ? steps.length : undefined,
      children: pending ?? (steps.length > 0 ? <MessageExtras steps={steps} /> : none),
    },
    {
      value: "context",
      label: t("message.debug.context"),
      children:
        pending ??
        (!payload ? noPayload : turnState ? <JsonTree value={turnState} /> : (
          <p className="text-sm text-muted-foreground">{t("message.debug.noContext")}</p>
        )),
    },
  ];

  return (
    <>
      <SheetHeader className="pr-12">
        <SheetTitle>{t("message.debug.title")}</SheetTitle>
        {/* Kept for screen-reader context (Radix requires a description); hidden visually. */}
        <SheetDescription className="sr-only">{t("message.debug.description")}</SheetDescription>
      </SheetHeader>

      {/* The tab row and its copy action stay put; only the open tab's body
          scrolls, so the action is in reach however long the content is. */}
      <ChipTabs
        tabs={tabs}
        value={tab}
        onValueChange={setTab}
        ariaLabel={t("message.debug.title")}
        className="min-h-0 flex-1 gap-4 px-4"
        listClassName="flex-wrap"
        contentClassName="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 pb-8"
        actions={copyable ? <CopyTabButton key={tab} text={copies[tab]} /> : undefined}
      />
    </>
  );
}

export function DebugSheet({ open, onOpenChange, target }: DebugSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 overflow-hidden">
        {target && <DebugSheetBody target={target} />}
      </SheetContent>
    </Sheet>
  );
}
