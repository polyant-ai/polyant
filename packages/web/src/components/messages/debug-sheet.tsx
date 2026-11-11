// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

/**
 * DebugSheet
 *
 * Right-side panel that shows, for a single assistant turn, everything exchanged
 * with the AI API: the turn's model, usage and latency with its request path
 * (every model call, hook run and tool run on the turn's clock), the system
 * prompt, the tool definitions, the history sent, and the conversation state
 * the model read.
 *
 * Everything is fetched when the sheet opens, from the message id alone, so the
 * message list carries none of it; a model call's raw exchanges are fetched
 * only when its row is opened.
 *
 * Shared by the playground and the conversation-detail page.
 */

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { api } from "@/lib/api";
import type { MessageDebug } from "@/lib/api";
import { Cpu } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { useResource } from "@/hooks/use-resource";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { JsonTree } from "./json-tree";
import { extractTurnState } from "./turn-state";
import { RequestPath } from "./request-path";
import { ChipTabs, type ChipTab } from "@/components/layout/chip-tabs";
import { useFormat } from "@/lib/use-format";
import { formatLatency } from "@/lib/format";

export interface DebugSheetTarget {
  conversationId: string;
  messageId: string;
  instanceId: string;
}

export interface DebugSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Target message to inspect. Null while no message is selected. */
  target: DebugSheetTarget | null;
}

const POLICY_KEY = {
  reply: "message.debug.path.policy.reply",
  progress: "message.debug.path.policy.progress",
  discard: "message.debug.path.policy.discard",
} as const;

/** The agent's model, usage and cost for the turn, then how it arrived and ran. */
function Summary({ debug }: { debug: MessageDebug }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const s = debug.summary;
  if (!s) return null;
  const prompt = s.promptTokens;
  const completion = s.completionTokens;
  const cacheRead = s.cachedInputTokens ?? 0;
  const cacheWrite = s.cacheCreationInputTokens ?? 0;
  const cost = s.cost;
  const fmtCost = (usd: number | undefined) => (usd != null ? fmt.currency(usd) : "—");
  const rows: Array<{ label: string; tokens: number; cost: number | undefined }> = [
    { label: t("conversations.detail.pills.input"), tokens: Math.max(0, prompt - cacheRead - cacheWrite), cost: cost?.input },
    ...(cacheRead > 0 ? [{ label: t("conversations.detail.pills.cacheRead"), tokens: cacheRead, cost: cost?.cacheRead }] : []),
    ...(cacheWrite > 0 ? [{ label: t("conversations.detail.pills.cacheWrite"), tokens: cacheWrite, cost: cost?.cacheWrite }] : []),
    { label: t("conversations.detail.pills.output"), tokens: completion, cost: cost?.output },
  ];

  const lat = s.latency;
  const diagnostics: Array<{ label: string; value: string }> = [];
  if (lat?.totalMs != null) diagnostics.push({ label: t("message.debug.latencyTotal"), value: formatLatency(lat.totalMs) });
  if (lat?.ttfbMs != null) diagnostics.push({ label: "TTFB", value: formatLatency(lat.ttfbMs) });
  if (lat?.llmCallMs != null) diagnostics.push({ label: t("message.debug.latencyLlm"), value: formatLatency(lat.llmCallMs) });
  if (lat?.contextPrepMs != null) diagnostics.push({ label: t("message.debug.latencyContextPrep"), value: formatLatency(lat.contextPrepMs) });
  if (lat?.toolBuildingMs != null) diagnostics.push({ label: t("message.debug.latencyToolBuilding"), value: formatLatency(lat.toolBuildingMs) });
  if (s.temperature != null) diagnostics.push({ label: t("conversations.detail.pills.temperature"), value: String(s.temperature) });
  if (s.thinking != null) {
    diagnostics.push({ label: t("conversations.detail.pills.thinking"), value: s.thinking ? t("message.debug.thinkingOn") : t("message.debug.thinkingOff") });
  }
  const turn = debug.turn;
  if (turn) {
    diagnostics.push({ label: t("message.debug.channel"), value: turn.channel });
    diagnostics.push({ label: t("message.debug.streaming"), value: turn.streaming ? t("message.debug.thinkingOn") : t("message.debug.thinkingOff") });
    const stt = turn.speechToText;
    if (stt) {
      diagnostics.push({ label: t("message.debug.sttProvider"), value: stt.provider });
      if (stt.audioDurationSec != null) diagnostics.push({ label: t("message.debug.audioDuration"), value: formatLatency(stt.audioDurationSec * 1000) });
      if (stt.durationMs != null) diagnostics.push({ label: t("message.debug.sttDuration"), value: formatLatency(stt.durationMs) });
    }
  }
  const policy = debug.path.intermediateText;
  diagnostics.push({ label: t("message.debug.path.policy.label"), value: t(policy ? POLICY_KEY[policy] : "message.debug.path.policy.unset") });

  return (
    <div className="flex flex-col gap-2">
      {s.model && (
        <div className="flex items-center gap-2 text-sm">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono">{s.model}</span>
          {s.provider && <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">{s.provider}</span>}
        </div>
      )}
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-muted-foreground">
            <th className="py-1 text-left font-normal">{t("message.debug.path.agentReply")}</th>
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
      {diagnostics.length > 0 && (
        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {diagnostics.map((r) => (
            <div key={r.label} className="flex justify-between border-t py-1.5">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="tabular-nums">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** The Model tab: the summary, then the request path. */
function ModelTab({ debug, target }: { debug: MessageDebug; target: DebugSheetTarget }) {
  return (
    <div className="flex flex-col gap-2">
      <Summary debug={debug} />
      <RequestPath
        debug={debug}
        path={debug.path}
        conversationId={target.conversationId}
        messageId={target.messageId}
        instanceId={target.instanceId}
      />
    </div>
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
  const turnState = payload ? extractTurnState(payload.messages) : null;

  // The tabs that hold what the model read can be copied: the system prompt
  // as its text, the messages and the conversation state as raw JSON.
  const copies: Record<string, string | undefined> = {
    prompt: payload?.system || undefined,
    messages: payload ? JSON.stringify(payload.messages, null, 2) : undefined,
    context: turnState ? JSON.stringify(turnState, null, 2) : undefined,
  };
  const copyable = tab in copies;

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
      children: pending ?? (data ? <ModelTab debug={data} target={target} /> : none),
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
                {tool.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{tool.description}</p>}
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
        actions={copyable ? <CopyButton
            key={tab}
            value={copies[tab] ?? ""}
            disabled={copies[tab] === undefined}
            variant="outline"
            copiedLabel={t("message.debug.copied")}
            errorMessage={t("message.debug.copyFailed")}
          /> : undefined}
      />
    </>
  );
}

export function DebugSheet({ open, onOpenChange, target }: DebugSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Wide: the request path is a table with a time axis. */}
      <SheetContent side="right" size="wide" className="gap-0 overflow-hidden">
        {target && <DebugSheetBody target={target} />}
      </SheetContent>
    </Sheet>
  );
}
