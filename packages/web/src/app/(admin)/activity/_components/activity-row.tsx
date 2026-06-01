// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Fragment, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, XCircle } from "lucide-react";
import { isSafeImageSrc } from "@/lib/utils";
import { narrate } from "@/lib/activity-stream/narrative";
import { NarrativeTokenView } from "@/lib/activity-stream/narrative-tokens";
import {
  KIND_ACCENTS,
  eventKind,
  type EventKind,
  type FeedEvent,
  type InstanceMeta,
  type RowLabels,
} from "@/lib/activity-stream/types";

/**
 * These event kinds carry user-generated content (the actual message body).
 * We never render their `responsePreview`/`text` to keep the live feed safe
 * to display on screen; the conversation viewer remains the place to read
 * the full content.
 */
const PRIVATE_KINDS: ReadonlySet<EventKind> = new Set(["inbound", "reply", "outbound"]);

interface Props {
  ev: FeedEvent;
  isLast: boolean;
  /** True for events that arrived after the page mounted — gets the
   * slide-in animation. False for the bus history replay (no animation). */
  isFresh: boolean;
  labels: RowLabels;
}

const FALLBACK_INSTANCE_ICON = "🤖";

// Renderable instance icons may have been stored by another user, so we
// only trust two well-known safe shapes: explicit `https://...` URLs or
// same-origin relative paths.  In particular we reject `data:` URIs to
// prevent an attacker who can edit `instance.icon` from smuggling an
// SVG-with-<script> that fires when the icon is broadcast over SSE.
// The icon-upload preview pipeline does NOT go through this guard — it
// renders the user's own freshly-generated canvas data URI locally,
// which never crosses a trust boundary.
function isImageIcon(icon: string): boolean {
  return isSafeImageSrc(icon);
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function ActivityRow({ ev, isLast, isFresh, labels }: Props) {
  const kind = eventKind(ev);
  const kindAccent = KIND_ACCENTS[kind];
  const isHandoff = kind === "agent-handoff" && ev.handoff !== undefined;

  const narrative = narrate(ev, labels.narrative);
  const sourcePill = derivSourcePill(ev);

  const isPrivateKind = PRIVATE_KINDS.has(kind);
  // For handoff events the prompt lives in `handoff.prompt`, not in
  // `argsPreview` — synthesize it locally so the existing "Args" section
  // renders without further branching.
  const effectiveArgsPreview = isHandoff ? ev.handoff!.prompt : ev.argsPreview;
  const hasArgs = Boolean(effectiveArgsPreview) && !isPrivateKind;
  const hasResult = Boolean(ev.resultPreview) && !isPrivateKind;
  const hasResponse = Boolean(ev.responsePreview) && !isPrivateKind;
  const hasMetaSection = hasCategoryMeta(ev);

  // `reply` rows are noisy when paired with a "Reply sent" placeholder —
  // the kind pill alone is enough. inbound/outbound still get the placeholder
  // to signal that the body is intentionally hidden for PII.
  const showPrivatePlaceholder = isPrivateKind && kind !== "reply";
  const hasAnyDetail =
    hasArgs || hasResult || hasResponse || hasMetaSection || showPrivatePlaceholder;

  const privateBodyText = showPrivatePlaceholder
    ? kind === "inbound"
      ? labels.privateBody.inbound
      : labels.privateBody.outbound
    : null;

  const [expanded, setExpanded] = useState(false);

  return (
    <li>
      <article
        data-current={isLast || undefined}
        className={`flex w-full gap-2 rounded-md border-l-2 px-3 py-3 transition-colors ${kindAccent.border} ${
          isLast ? "bg-accent/10" : "bg-card"
        } ${isFresh ? "animate-feed-row-in" : ""}`}
      >
        {/* ── Avatar column — single (size-10) or dual for handoff ───────── */}
        <div className="flex shrink-0 pt-0.5">
          {isHandoff ? (
            <HandoffAvatars from={ev.handoff!.fromInstance} to={ev.handoff!.toInstance} />
          ) : (
            <InstanceAvatar icon={ev.instance?.icon ?? null} name={ev.instance?.name ?? labels.fallbackInstance} />
          )}
        </div>

        {/* ── Right column: narrative header + (optionally) body ─────────── */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* Header: single narrative sentence + side pills + chevron. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {narrative.pending && (
              <Loader2
                className={`size-4 shrink-0 animate-spin ${kindAccent.fg}`}
                aria-hidden
              />
            )}
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
              {narrative.tokens.map((tok, i) => (
                <NarrativeTokenView key={i} token={tok} />
              ))}
            </span>

            {/* Channel/webhook/cron source — complementary info at a glance. */}
            {sourcePill && (
              <span className="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                <span aria-hidden>{sourcePill.icon}</span>
                <span>{sourcePill.label}</span>
              </span>
            )}

            {ev.status === "error" && (
              <XCircle className="text-destructive size-3.5 shrink-0" aria-hidden />
            )}
            {ev.status === "success" && (isHandoff || kind === "tool") && (
              <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
            )}

            <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs">
              <Clock className="size-3.5" aria-hidden />
              <span className="tabular-nums">{formatTime(ev.ts)}</span>
            </span>

            {hasAnyDetail && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={expanded ? labels.collapse : labels.expand}
                title={expanded ? labels.collapse : labels.expand}
                className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center rounded-sm transition-colors"
              >
                {expanded ? (
                  <ChevronDown className="size-4" aria-hidden />
                ) : (
                  <ChevronRight className="size-4" aria-hidden />
                )}
              </button>
            )}
          </div>

          {/* Collapsible body — surfaced only when the user expands the row. */}
          {expanded && hasAnyDetail && (
            <div className="flex flex-col gap-3 text-xs">
              {privateBodyText && (
                <p className="text-muted-foreground italic">{privateBodyText}</p>
              )}
              {hasArgs && (
                <Section title={isHandoff ? "Prompt" : "Args"}>
                  <pre
                    title={effectiveArgsPreview}
                    className={`bg-muted/60 overflow-hidden rounded-sm p-2 font-mono leading-relaxed whitespace-pre-wrap ${
                      isHandoff ? "line-clamp-3" : "line-clamp-6"
                    }`}
                  >
                    {effectiveArgsPreview}
                  </pre>
                </Section>
              )}
              {hasResult && (
                <Section title="Result">
                  <pre
                    title={ev.resultPreview}
                    className="bg-muted/60 line-clamp-6 overflow-hidden rounded-sm p-2 font-mono leading-relaxed whitespace-pre-wrap"
                  >
                    {ev.resultPreview}
                  </pre>
                </Section>
              )}
              {hasResponse && (
                <Section title={labels.bodyLabels[kind]}>
                  <blockquote
                    title={ev.responsePreview}
                    className={`border-muted-foreground/30 overflow-hidden border-l-2 pl-2 leading-relaxed ${
                      kind === "webhook" ? "line-clamp-3" : "line-clamp-8"
                    } ${kind === "thinking" ? "text-muted-foreground italic" : ""}`}
                  >
                    {ev.responsePreview}
                  </blockquote>
                </Section>
              )}
              {hasMetaSection && (
                <Section title={labels.meta}>
                  <CategoryMeta ev={ev} labels={labels} />
                </Section>
              )}
            </div>
          )}
        </div>
      </article>
    </li>
  );
}

/** Map a channel type / webhook source to a single-emoji icon. */
const CHANNEL_ICONS: Record<string, string> = {
  web: "🌐",
  telegram: "✈️",
  whatsapp: "💬",
  slack: "#️⃣",
  email: "✉️",
  room: "🏠",
  scheduled: "⏰",
};

function channelIcon(name: string): string {
  return CHANNEL_ICONS[name.toLowerCase()] ?? "📡";
}

/**
 * Derive a "source" pill (channel or webhook origin) for events where it's
 * meaningful: inbound/outbound get the channel, webhook gets the source name,
 * conversation lifecycle gets the channel, cron gets a clock badge.
 */
function derivSourcePill(ev: FeedEvent): { icon: string; label: string } | null {
  if (ev.channel?.type) {
    return { icon: channelIcon(ev.channel.type), label: ev.channel.type };
  }
  if (ev.webhook?.source) {
    return { icon: "🔔", label: ev.webhook.source };
  }
  if (ev.conversation?.channel) {
    return { icon: channelIcon(ev.conversation.channel), label: ev.conversation.channel };
  }
  if (ev.cron) {
    return { icon: "⏰", label: ev.cron.schedule };
  }
  return null;
}

function hasCategoryMeta(ev: FeedEvent): boolean {
  return Boolean(
    ev.channel || ev.webhook || ev.cron || ev.memory || ev.conversation,
  );
}

function CategoryMeta({ ev, labels }: { ev: FeedEvent; labels: RowLabels }) {
  const f = labels.metaFields;
  const rows: Array<{ k: string; v: string }> = [];

  if (ev.channel) {
    rows.push({ k: f.channel, v: `${ev.channel.type} · ${ev.channel.id}` });
    if (ev.channel.sender) rows.push({ k: f.sender, v: ev.channel.sender });
  }
  if (ev.webhook) {
    rows.push({ k: f.source, v: ev.webhook.source });
    rows.push({ k: f.match, v: ev.webhook.definition });
    rows.push({ k: f.action, v: ev.webhook.action });
  }
  if (ev.cron) {
    rows.push({ k: f.schedule, v: ev.cron.schedule });
    if (ev.cron.runId) rows.push({ k: f.runId, v: ev.cron.runId });
    if (ev.cron.triggerType) rows.push({ k: f.trigger, v: ev.cron.triggerType });
  }
  if (ev.memory) {
    rows.push({ k: f.count, v: String(ev.memory.count) });
    if (ev.memory.categories.length > 0) {
      rows.push({ k: f.categories, v: ev.memory.categories.join(", ") });
    }
  }
  if (ev.conversation) {
    rows.push({ k: f.lifecycle, v: ev.conversation.lifecycle });
    if (ev.conversation.source) rows.push({ k: f.source, v: ev.conversation.source });
    if (ev.conversation.channel) rows.push({ k: f.channel, v: ev.conversation.channel });
  }

  if (rows.length === 0) return null;
  return (
    <dl className="bg-muted/40 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-sm p-2 font-mono">
      {rows.map((r, i) => (
        <Fragment key={i}>
          <dt className="text-muted-foreground">{r.k}</dt>
          <dd className="text-foreground break-all">{r.v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function InstanceAvatar({ icon, name }: { icon: string | null; name: string }) {
  const safeIcon = icon || FALLBACK_INSTANCE_ICON;
  if (isImageIcon(safeIcon)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={safeIcon} alt={name} className="size-10 rounded-md object-cover shrink-0" />
    );
  }
  return (
    <span
      aria-hidden
      title={name}
      className="flex size-10 items-center justify-center rounded-md bg-muted text-2xl leading-none shrink-0"
    >
      {safeIcon}
    </span>
  );
}

/** Dual-avatar block for `agent-handoff` rows: caller → arrow → target. */
function HandoffAvatars({ from, to }: { from: InstanceMeta; to: InstanceMeta }) {
  return (
    <div className="flex items-center gap-1.5">
      <InstanceAvatar icon={from.icon} name={from.name} />
      <span className="text-indigo-500 shrink-0" aria-hidden>
        →
      </span>
      <InstanceAvatar icon={to.icon} name={to.name} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-muted-foreground text-[9px] font-medium tracking-wider uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}
