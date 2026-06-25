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
import { useI18n } from "@/lib/i18n/context";
import { api } from "@/lib/api";
import type { MessageDebug } from "@/lib/api";
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

export interface DebugSheetTarget {
  conversationId: string;
  messageId: string;
  agentId: string;
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
      .messageDebug(target.conversationId, target.messageId, target.agentId)
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
          <SheetTitle>{t("message.debug.title")}</SheetTitle>
          <SheetDescription>{t("message.debug.description")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-8">
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
