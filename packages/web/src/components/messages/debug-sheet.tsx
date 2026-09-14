// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

/**
 * DebugSheet
 *
 * Right-side panel that shows, for a single assistant turn, everything exchanged
 * with the AI API: the exact LLM request payload (full system prompt, the messages
 * array sent, and the tool definitions) plus the per-step tool I/O timeline.
 *
 * The heavy payload is fetched on-demand (on open) via the per-message debug
 * endpoint, so the message list stays light. The payload is only present when the
 * instance had DEBUG mode on at generation time; otherwise only the step trace is
 * shown with a notice.
 *
 * Shared by the playground and the conversation-detail page — both pass a
 * conversationId + the DB message id + the instance slug.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n/context";
import { api } from "@/lib/api";
import type { MessageDebug, CostBreakdown, MessageLatency } from "@/lib/api";
import { Check, Copy, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { MessageExtras } from "./message-extras";
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

function JsonBlock({ value }: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed">
      {text}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

/** Model + token/cost breakdown for the turn. Rendered from the target metadata. */
function UsageSection({ target }: { target: DebugSheetTarget }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const prompt = target.promptTokens ?? 0;
  const completion = target.completionTokens ?? 0;
  const cacheRead = target.cachedInputTokens ?? 0;
  const cacheWrite = target.cacheCreationInputTokens ?? 0;
  const regularInput = Math.max(0, prompt - cacheRead - cacheWrite);
  const cost = target.cost;

  if (!target.model && prompt === 0 && completion === 0) return null;

  const fmtCost = (usd: number | undefined) => (usd != null ? `$${usd.toFixed(4)}` : "—");
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
    <Section title={t("message.debug.usage")}>
      {target.model && (
        <div className="flex items-center gap-2 text-sm">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono">{target.model}</span>
          {target.provider && (
            <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {target.provider}
            </span>
          )}
        </div>
      )}
      <table className="w-full text-xs tabular-nums">
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
      <DiagnosticsList target={target} />
    </Section>
  );
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** Latency breakdown + sampling knobs for the turn. */
function DiagnosticsList({ target }: { target: DebugSheetTarget }) {
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

  if (rows.length === 0) return null;

  return (
    <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between border-t py-1.5">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className="tabular-nums">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The turn as one object, in the shape the sheet displays it.
 *
 * Built from `data`, never from the DOM: what is on screen is an accordion of
 * tool definitions and a step timeline, and selecting across that by hand is
 * the reason this button exists. `tools` is narrowed to the three fields the
 * sheet shows, so the export says the same thing the panel does.
 *
 * Returns null when there is nothing to hand over — no captured payload and no
 * steps — which is what disables the button rather than copying `{}`.
 */
function turnExport(data: MessageDebug | null): Record<string, unknown> | null {
  if (!data) return null;
  const payload = data.debugPayload ?? null;
  const steps = data.steps ?? [];
  if (!payload && steps.length === 0) return null;
  return {
    // DEBUG was off at generation time: the three payload fields are absent
    // rather than empty, so a reader cannot mistake "not captured" for "empty".
    ...(payload
      ? {
          system: payload.system,
          messages: payload.messages,
          tools: payload.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }
      : {}),
    steps,
  };
}

/** Copies the whole turn as JSON, and says so for a moment afterwards. */
function CopyTurnButton({ data }: { data: MessageDebug | null }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const exportable = turnExport(data);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (!exportable) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportable, null, 2));
      setCopied(true);
    } catch {
      // A denied clipboard permission or an insecure origin: the failure is
      // silent otherwise, and the user would be left believing they copied.
      toast.error(t("message.debug.copyFailed"));
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      disabled={!exportable}
      title={exportable ? undefined : t("message.debug.copyEmpty")}
      onClick={handleCopy}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? t("message.debug.copied") : t("message.debug.copyAll")}
    </Button>
  );
}

export function DebugSheet({ open, onOpenChange, target }: DebugSheetProps) {
  const { t } = useI18n();
  const [data, setData] = useState<MessageDebug | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    setData(null);
    api.conversations
      .messageDebug(target.conversationId, target.messageId, target.instanceId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, target]);

  const payload = data?.debugPayload ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          {/* The copy action sits in the header, beside the title: the thing it
              copies is several screens tall, so an action at the bottom would be
              reachable only after the scrolling it exists to spare. */}
          <div className="flex items-center justify-between gap-2 pr-8">
            <SheetTitle>{t("message.debug.title")}</SheetTitle>
            <CopyTurnButton data={data} />
          </div>
          {/* Kept for screen-reader context (Radix requires a description); hidden visually. */}
          <SheetDescription className="sr-only">{t("message.debug.description")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-8">
          {target && <UsageSection target={target} />}
          {loading && <p className="text-sm text-muted-foreground">{t("message.debug.loading")}</p>}
          {error && <p className="text-sm text-destructive">{t("message.debug.error")}</p>}

          {!loading && !error && data && (
            <>
              {payload ? (
                <>
                  <Section title={t("message.debug.systemPrompt")}>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed">
                      {payload.system || "—"}
                    </pre>
                  </Section>

                  <Section title={t("message.debug.messages")}>
                    <JsonBlock value={payload.messages} />
                  </Section>

                  <Section title={t("message.debug.tools")}>
                    {payload.tools.length === 0 ? (
                      <p className="text-xs text-muted-foreground">—</p>
                    ) : (
                      <Accordion type="multiple" className="flex flex-col gap-2">
                        {payload.tools.map((tool) => (
                          <AccordionItem
                            key={tool.name}
                            value={tool.name}
                            className="rounded-md border bg-background/50 last:border-b"
                          >
                            <AccordionTrigger className="px-2 py-2 font-mono text-xs font-semibold">
                              {tool.name}
                            </AccordionTrigger>
                            <AccordionContent className="px-2">
                              {tool.description && (
                                <p className="text-[11px] text-muted-foreground">{tool.description}</p>
                              )}
                              {tool.parameters != null && (
                                <div className="mt-2">
                                  <div className="mb-1 text-[11px] text-muted-foreground">
                                    {t("message.debug.toolParams")}
                                  </div>
                                  <JsonBlock value={tool.parameters} />
                                </div>
                              )}
                            </AccordionContent>
                          </AccordionItem>
                        ))}
                      </Accordion>
                    )}
                  </Section>
                </>
              ) : (
                <p className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                  {t("message.debug.noPayload")}
                </p>
              )}

              {data.steps && data.steps.length > 0 && (
                <Section title={t("message.debug.steps")}>
                  <MessageExtras steps={data.steps} defaultOpen />
                </Section>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
