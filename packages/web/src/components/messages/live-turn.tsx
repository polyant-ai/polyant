// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Brain, CheckCircle2, Loader2, Wrench, XCircle } from "lucide-react";
import { ActivityRow } from "./activity-row";
import { useI18n } from "@/lib/i18n/context";
import { eventKind, type EventKind, type FeedEvent } from "@/lib/activity-stream/types";

/**
 * The kinds a turn is made of. Others (channel delivery, memory extraction,
 * lifecycle) can land after the turn is stored and would leave it looking
 * unfinished.
 */
const TURN_KINDS = new Set<EventKind>(["inbound", "thinking", "tool", "reply"]);

function Dots({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1 py-1" role="status" aria-label={label}>
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
    </span>
  );
}

/** Split the turn at each incoming message: one user message, then the agent's work on it. */
function segments(turn: FeedEvent[]): { inbound?: FeedEvent; work: FeedEvent[] }[] {
  const out: { inbound?: FeedEvent; work: FeedEvent[] }[] = [];
  for (const evt of turn) {
    if (eventKind(evt) === "inbound" || out.length === 0) out.push({ inbound: eventKind(evt) === "inbound" ? evt : undefined, work: [] });
    if (eventKind(evt) !== "inbound") out[out.length - 1].work.push(evt);
  }
  return out;
}

/**
 * The turn in progress, drawn from live activity events until its rows are
 * stored and the transcript takes over. Laid out like a stored turn: the
 * agent's activity above its reply, in one column. Previews are capped by the
 * engine, so a long reply shows in full only once it is stored.
 */
export function LiveTurn({ events, showActivity }: { events: FeedEvent[]; showActivity: boolean }) {
  const { t } = useI18n();
  const turn = events.filter((evt) => TURN_KINDS.has(eventKind(evt)));
  if (turn.length === 0) return null;

  const activityRow = (evt: FeedEvent) => eventKind(evt) === "thinking" ? (
    <ActivityRow
      key={evt.id}
      icon={<Brain className="size-3.5" />}
      iconLabel={t("message.reasoning.label")}
      tone="reasoning"
      detail={<p className="whitespace-pre-wrap break-words">{evt.responsePreview ?? evt.text}</p>}
    >
      {t("message.reasoning.label")}
    </ActivityRow>
  ) : (
    <ActivityRow
      key={evt.id}
      icon={<Wrench className="size-3.5" />}
      iconLabel={t("message.activity.tool")}
      tone="tool"
      status={evt.status === "error" ? (
        <XCircle className="size-4 shrink-0 text-destructive" aria-label={t("message.activity.failed")} />
      ) : evt.status === "success" ? (
        <CheckCircle2 className="size-4 shrink-0 text-success" aria-label={t("message.activity.succeeded")} />
      ) : (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label={t("message.activity.running")} />
      )}
      detail={evt.argsPreview || evt.resultPreview ? (
        <div className="space-y-2">
          {evt.argsPreview && <div>
            <p className="mb-1 font-medium">{t("message.steps.args")}</p>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs text-foreground">{evt.argsPreview}</pre>
          </div>}
          {evt.resultPreview && <div>
            <p className="mb-1 font-medium">{t("message.steps.result")}</p>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs text-foreground">{evt.resultPreview}</pre>
          </div>}
        </div>
      ) : undefined}
    >
      {t("message.activity.called")} <code className="rounded bg-muted px-1 py-0.5 font-semibold">{evt.tool?.name ?? evt.text}</code>
    </ActivityRow>
  );

  return (
    <div className="space-y-4" aria-live="polite">
      {segments(turn).map(({ inbound, work }, index) => {
        const reply = work.find((evt) => eventKind(evt) === "reply");
        const activity = showActivity ? work.filter((evt) => eventKind(evt) !== "reply") : [];
        return (
          <div key={inbound?.id ?? `segment-${index}`} className="space-y-4">
            {inbound && (
              <div className="flex justify-end">
                <div className="min-w-0 max-w-[75%] overflow-hidden break-words rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground">
                  <p className="whitespace-pre-wrap">{inbound.responsePreview ?? inbound.text}</p>
                </div>
              </div>
            )}
            <div className="flex justify-start">
              <div className="min-w-0 max-w-[85%]">
                {activity.length > 0 && <div className="mb-3">{activity.map(activityRow)}</div>}
                <div className="w-fit min-w-0 max-w-full overflow-hidden break-words rounded-2xl bg-muted px-4 py-3 text-sm">
                  {reply ? (
                    // A failed stream arrives as an error reply carrying the failure text.
                    <p className={`whitespace-pre-wrap ${reply.status === "error" ? "text-destructive" : ""}`}>{reply.responsePreview ?? reply.text}</p>
                  ) : (
                    <Dots label={t("conversations.detail.liveWorking")} />
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
