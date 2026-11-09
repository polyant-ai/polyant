// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

/**
 * RequestPath
 *
 * Everything that happened in one turn, on the turn's own clock: the hook runs,
 * the agent's model calls and their steps, the tools each step ran, the model
 * calls a hook or a tool made, the calls the engine made around the turn
 * (title, memory, summary…), and the moment the reply was handed to the
 * channel. Each row opens onto what went in and came out: a hook's or a tool's
 * input and output, or a model call's raw request and response, fetched when
 * the row is opened.
 */

import { createContext, useContext, useState, type ReactNode } from "react";
import { Bot, ChevronRight, Cpu, MessageSquareText, Send, Settings2, Webhook, Wrench, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import { api } from "@/lib/api";
import type { MessageDebug, PathExchange, PathHookRun, PathModelCall, StepDetail } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { useFormat } from "@/lib/use-format";
import { formatLatency } from "@/lib/format";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { JsonTree } from "./json-tree";

type Path = NonNullable<MessageDebug["path"]>;

interface TurnClock {
  conversationId: string;
  messageId: string;
  instanceId: string;
  /** t0, epoch ms. */
  t0: number;
  /** The span the time bars cover, ms from t0. */
  span: number;
  /** When the reply was handed to the channel, ms from t0. */
  sentAt: number | null;
  locale: string;
}

const Clock = createContext<TurnClock | null>(null);

function useClock(): TurnClock {
  const clock = useContext(Clock);
  if (!clock) throw new Error("RequestPath rows render inside RequestPath");
  return clock;
}

const GRID = "grid grid-cols-[1rem_minmax(0,1fr)_11.5rem_4.5rem_7rem_4rem_7rem_4.5rem_3.75rem] items-center gap-x-3";

type Tone = "agent" | "hook" | "tool" | "system" | "nested" | "error";

const TONE: Record<Tone, { icon: string; bar: string }> = {
  agent: { icon: "text-foreground", bar: "bg-primary" },
  hook: { icon: "text-warning", bar: "bg-warning/70" },
  tool: { icon: "text-foreground/70", bar: "bg-foreground/40" },
  system: { icon: "text-muted-foreground", bar: "bg-muted-foreground/40" },
  nested: { icon: "text-muted-foreground", bar: "bg-muted-foreground/40" },
  error: { icon: "text-destructive", bar: "bg-destructive" },
};

/** The purposes the engine names its own calls by. */
const PURPOSE_KEY: Record<string, TranslationKey> = {
  title: "message.debug.path.purpose.title",
  summary: "message.debug.path.purpose.summary",
  memory: "message.debug.path.purpose.memory",
  webhook_match: "message.debug.path.purpose.webhookMatch",
  prompt_rewrite: "message.debug.path.purpose.promptRewrite",
  room_compaction: "message.debug.path.purpose.roomCompaction",
  sub_task: "message.debug.path.purpose.subTask",
};

const HOOK_EVENT_KEY: Record<string, TranslationKey> = {
  conversation_start: "message.debug.path.event.conversationStart",
  message_received: "message.debug.path.event.messageReceived",
  response_generated: "message.debug.path.event.responseGenerated",
  response_sent: "message.debug.path.event.responseSent",
};

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);

function dateTime(epoch: number, locale: string): string {
  const d = new Date(epoch);
  const day = d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 });
  return `${day} ${time}`;
}

/** Time since t0, always in seconds, so the column reads as one running count. */
function sinceT0(offset: number, locale: string): string {
  return `+${(offset / 1000).toLocaleString(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} s`;
}

function Bar({ start, duration, tone }: { start: number; duration: number; tone: Tone }) {
  const { span, sentAt } = useClock();
  const left = Math.max(0, (start / span) * 100);
  const width = Math.max((duration / span) * 100, 1.5);
  return (
    <div className="relative h-2 w-full rounded-full bg-muted">
      <div className={cn("absolute top-0 h-2 rounded-full", TONE[tone].bar)} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
      {sentAt !== null && (
        <div className="absolute -bottom-1 -top-1 w-0.5 rounded bg-[var(--chart-2)]" style={{ left: `${(sentAt / span) * 100}%` }} />
      )}
    </div>
  );
}

function Outcome({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return <span />;
  return (
    <span className="text-right" title={label}>
      <span role="img" aria-label={label} className="saturate-50">
        {ok ? "✅" : "❌"}
      </span>
    </span>
  );
}

interface RowProps {
  depth: number;
  icon: LucideIcon;
  tone: Tone;
  title: ReactNode;
  sub?: ReactNode;
  /** ms from t0; null when the row was recorded without a start. */
  start: number | null;
  duration: number;
  tokens?: [number, number];
  cost?: number;
  ok: boolean | null;
  okLabel: string;
  detail?: ReactNode;
  children?: ReactNode;
  strong?: boolean;
}

function Row({ depth, icon: Icon, tone, title, sub, start, duration, tokens, cost, ok, okLabel, detail, children, strong }: RowProps) {
  const fmt = useFormat();
  const { t0, locale } = useClock();
  const [open, setOpen] = useState(false);
  const cells = (
    <>
      {detail ? <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} /> : <span />}
      <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${depth * 1.25}rem` }}>
        <Icon className={cn("size-4 shrink-0", TONE[tone].icon)} aria-hidden />
        <span className="min-w-0">
          <span className={cn("block truncate", strong && "font-medium")}>{title}</span>
          {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
        </span>
      </span>
      <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{start !== null ? dateTime(t0 + start, locale) : "—"}</span>
      <span className="text-right font-mono text-xs">{start !== null ? sinceT0(start, locale) : ""}</span>
      {start !== null ? <Bar start={start} duration={duration} tone={tone} /> : <span />}
      <span className="text-right">{formatLatency(duration)}</span>
      <span className="text-right">{tokens ? `${fmt.number(tokens[0])} / ${fmt.number(tokens[1])}` : ""}</span>
      <span className="text-right">{cost !== undefined ? fmt.currency(cost) : ""}</span>
      <Outcome ok={ok} label={okLabel} />
    </>
  );
  return (
    <div className={cn(depth === 0 && "border-t")}>
      {detail ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(GRID, "w-full py-1.5 text-left text-sm tabular-nums hover:bg-muted/50")}>
          {cells}
        </button>
      ) : (
        <div className={cn(GRID, "py-1.5 text-sm tabular-nums")}>{cells}</div>
      )}
      {open && detail && <div className="pb-3 pr-2 pt-1" style={{ paddingLeft: `${depth * 1.25 + 2.25}rem` }}>{detail}</div>}
      {children}
    </div>
  );
}

/** Two small switches over a body: one level below the sheet's tabs. */
function Pair({ labels, left, right, meta }: { labels: [string, string]; left: unknown; right: unknown; meta?: [string, string] }) {
  const { t } = useI18n();
  const [side, setSide] = useState<0 | 1>(0);
  const body = side === 0 ? left : right;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        {labels.map((label, i) => (
          <button
            key={label}
            type="button"
            aria-pressed={side === i}
            onClick={() => setSide(i as 0 | 1)}
            className={cn(
              "rounded px-2 py-0.5 text-xs transition-colors",
              side === i ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
        {meta && <span className="ml-2 truncate font-mono text-xs text-muted-foreground">{meta[side]}</span>}
        <CopyButton value={typeof body === "string" ? body : JSON.stringify(body ?? null, null, 2)} label={t("common.copy")} className="ml-auto size-7" />
      </div>
      {body === null || body === undefined ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : typeof body === "string" ? (
        <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-[13px]">{body}</pre>
      ) : (
        <JsonTree value={body} className="max-h-[28rem] overflow-y-auto" />
      )}
    </div>
  );
}

/** A call's raw exchanges for one step, fetched when its row opens. */
function Exchanges({ call, stepIndex }: { call: PathModelCall; stepIndex: number }) {
  const { t } = useI18n();
  const { conversationId, messageId, instanceId } = useClock();
  const { data, error, loading } = useResource(call.exchangeCount > 0 ? [conversationId, messageId, call.id] : null, () =>
    api.conversations.callExchanges(conversationId, messageId, call.id, instanceId),
  );
  const [attempt, setAttempt] = useState<number | null>(null);
  if (call.exchangeCount === 0) {
    return (
      <p className="rounded-md border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">{t("message.debug.path.noExchanges")}</p>
    );
  }
  if (loading) return <p className="text-sm text-muted-foreground">{t("message.debug.loading")}</p>;
  if (error !== undefined || !data) return <p className="text-sm text-destructive">{t("message.debug.path.exchangesError")}</p>;
  const tries: PathExchange[] = data.exchanges.filter((e) => e.stepIndex === stepIndex);
  if (tries.length === 0) return <p className="text-sm text-muted-foreground">{t("message.debug.path.noExchangeForStep")}</p>;
  const shown = tries.find((e) => e.attempt === attempt) ?? tries[tries.length - 1];
  return (
    <div className="flex flex-col gap-2">
      {tries.length > 1 && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {tries.map((e) => (
            <button
              key={e.attempt}
              type="button"
              aria-pressed={e === shown}
              onClick={() => setAttempt(e.attempt)}
              className={cn("rounded px-2 py-0.5", e === shown ? "bg-secondary text-foreground" : "hover:text-foreground")}
            >
              {t("message.debug.path.attempt", { n: e.attempt })}
            </button>
          ))}
        </div>
      )}
      <Pair
        labels={[t("message.debug.path.request"), t("message.debug.path.response")]}
        left={shown.request}
        right={shown.response}
        meta={[`${call.provider} · ${call.model}`, shown.status !== null ? `HTTP ${shown.status}` : t("message.debug.path.noStatus")]}
      />
    </div>
  );
}

function outcomeLabel(t: (k: TranslationKey) => string, outcome: string, errorKind: string | null): string {
  if (outcome === "ok") return t("message.debug.outcomeOk");
  if (outcome === "aborted") return t("message.debug.outcomeAborted");
  return errorKind ? `${t("message.debug.outcomeError")}: ${errorKind}` : t("message.debug.outcomeError");
}

/** A model call a hook or a tool made, under the run that made it. */
function NestedCall({ call, depth, t0 }: { call: PathModelCall; depth: number; t0: number }) {
  const { t } = useI18n();
  return (
    <Row
      depth={depth}
      icon={Cpu}
      tone={call.outcome === "ok" ? "nested" : "error"}
      title={t("message.debug.path.modelCall")}
      sub={<span className="font-mono">{call.model}</span>}
      start={offsetOf(call.startedAt, t0)}
      duration={call.durationMs}
      tokens={[call.promptTokens, call.completionTokens]}
      cost={call.costUsd}
      ok={call.outcome === "ok"}
      okLabel={outcomeLabel(t, call.outcome, call.errorKind)}
      detail={<Exchanges call={call} stepIndex={0} />}
    />
  );
}

function offsetOf(iso: string | null | undefined, t0: number): number | null {
  const at = ms(iso);
  return at === null ? null : at - t0;
}

/** What became of text a step wrote alongside a tool call. */
function textFate(policy: Path["intermediateText"], streaming: boolean): { key: TranslationKey; sent: boolean } {
  if (policy === "reply") return { key: "message.debug.path.fate.reply", sent: true };
  if (policy === "progress") return streaming ? { key: "message.debug.path.fate.progress", sent: true } : { key: "message.debug.path.fate.progressNoStream", sent: false };
  if (policy === "discard") return { key: "message.debug.path.fate.discard", sent: false };
  return streaming ? { key: "message.debug.path.fate.unsetStream", sent: true } : { key: "message.debug.path.fate.unsetBuffered", sent: false };
}

function StepText({ text, depth, policy, streaming }: { text: string; depth: number; policy: Path["intermediateText"]; streaming: boolean }) {
  const { t } = useI18n();
  const fate = textFate(policy, streaming);
  return (
    <div className="flex items-start gap-2 py-1 pr-2 text-sm" style={{ paddingLeft: `${depth * 1.25 + 1.75}rem` }}>
      <MessageSquareText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", fate.sent ? "text-foreground" : "text-muted-foreground")}>
        «{text}»
      </span>
      <span
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 text-xs",
          fate.sent ? "border-foreground/30 text-foreground" : "border-dashed text-muted-foreground",
        )}
      >
        {t(fate.key)}
      </span>
    </div>
  );
}

function stepLine(t: (k: TranslationKey, v?: Record<string, string | number>) => string, step: StepDetail): string {
  if (step.toolCalls.length > 0) return t("message.debug.path.asksTools", { tools: step.toolCalls.map((c) => c.toolName).join(", ") });
  return step.text || t("message.debug.path.answers");
}

interface AgentCallProps {
  call: PathModelCall;
  /** The steps of the delivered pass, when this call is it. */
  steps: StepDetail[] | null;
  nested: Map<string, PathModelCall[]>;
  t0: number;
  policy: Path["intermediateText"];
  streaming: boolean;
}

function AgentCall({ call, steps, nested, t0, policy, streaming }: AgentCallProps) {
  const { t } = useI18n();
  const ok = call.outcome === "ok";
  const multi = (steps?.length ?? 0) > 1;
  const start = offsetOf(call.startedAt, t0);
  return (
    <Row
      depth={0}
      icon={Bot}
      tone={ok ? "agent" : "error"}
      strong
      title={t("message.debug.path.agent")}
      sub={
        <>
          <span className="font-mono">{call.model}</span> · {t("message.debug.path.steps", { count: call.stepCount })}
        </>
      }
      start={start}
      duration={call.durationMs}
      tokens={[call.promptTokens, call.completionTokens]}
      cost={call.costUsd}
      ok={ok}
      okLabel={outcomeLabel(t, call.outcome, call.errorKind)}
      detail={multi ? undefined : <Exchanges call={call} stepIndex={0} />}
    >
      {(multi ? steps! : []).map((step) => (
        <Row
          key={step.index}
          depth={1}
          icon={Cpu}
          tone="agent"
          title={t("message.debug.path.step", { n: step.index + 1 })}
          sub={stepLine(t, step)}
          start={offsetOf(step.startedAt, t0)}
          duration={step.durationMs}
          tokens={step.promptTokens !== undefined ? [step.promptTokens, step.completionTokens ?? 0] : undefined}
          ok={null}
          okLabel=""
          detail={<Exchanges call={call} stepIndex={step.index} />}
        >
          {step.toolCalls.length > 0 && step.text && <StepText text={step.text} depth={2} policy={policy} streaming={streaming} />}
          {step.toolCalls.map((tc) => {
            const result = step.toolResults?.find((r) => r.toolCallId === tc.toolCallId)?.result;
            const failed = isFailedResult(result);
            return (
              <Row
                key={tc.toolCallId}
                depth={2}
                icon={Wrench}
                tone="tool"
                title={
                  <>
                    {t("message.debug.path.tool")} <span className="font-mono">{tc.toolName}</span>
                  </>
                }
                sub={nested.has(tc.toolCallId) ? t("message.debug.path.callsModel") : undefined}
                start={offsetOf(tc.startedAt, t0)}
                duration={tc.durationMs ?? 0}
                ok={result === undefined ? null : !failed}
                okLabel={failed ? t("message.debug.outcomeError") : t("message.debug.outcomeOk")}
                detail={<Pair labels={[t("message.debug.path.input"), t("message.debug.path.output")]} left={tc.args} right={result} />}
              >
                {(nested.get(tc.toolCallId) ?? []).map((c) => (
                  <NestedCall key={c.id} call={c} depth={3} t0={t0} />
                ))}
              </Row>
            );
          })}
        </Row>
      ))}
    </Row>
  );
}

function isFailedResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (("isError" in result && result.isError === true) ||
      ("success" in result && result.success === false) ||
      ("error" in result && typeof result.error === "string" && result.error.length > 0))
  );
}

function HookRow({ run, nested, t0 }: { run: PathHookRun; nested: PathModelCall[]; t0: number }) {
  const { t } = useI18n();
  return (
    <Row
      depth={0}
      icon={Webhook}
      tone={run.success ? "hook" : "error"}
      title={
        <>
          {t("message.debug.path.hook")} <span className="font-mono">{run.name}</span>
        </>
      }
      sub={HOOK_EVENT_KEY[run.event] ? t(HOOK_EVENT_KEY[run.event]) : run.event}
      start={offsetOf(run.startedAt, t0)}
      duration={run.durationMs}
      ok={run.success}
      okLabel={run.success ? t("message.debug.outcomeOk") : `${t("message.debug.outcomeError")}: ${run.error ?? ""}`}
      detail={<Pair labels={[t("message.debug.path.input"), t("message.debug.path.output")]} left={run.args} right={run.error ?? run.result} />}
    >
      {nested.map((c) => (
        <NestedCall key={c.id} call={c} depth={1} t0={t0} />
      ))}
    </Row>
  );
}

function SystemCall({ call, t0 }: { call: PathModelCall; t0: number }) {
  const { t } = useI18n();
  const purpose = call.purpose && PURPOSE_KEY[call.purpose] ? t(PURPOSE_KEY[call.purpose]) : (call.purpose ?? call.callType);
  return (
    <Row
      depth={0}
      icon={Settings2}
      tone={call.outcome === "ok" ? "system" : "error"}
      title={`${t("message.debug.path.system")} · ${purpose}`}
      sub={<span className="font-mono">{call.model}</span>}
      start={offsetOf(call.startedAt, t0)}
      duration={call.durationMs}
      tokens={[call.promptTokens, call.completionTokens]}
      cost={call.costUsd}
      ok={call.outcome === "ok"}
      okLabel={outcomeLabel(t, call.outcome, call.errorKind)}
      detail={<Exchanges call={call} stepIndex={0} />}
    />
  );
}

function SentRow({ at, text }: { at: number; text: string }) {
  const { t } = useI18n();
  const { t0, locale } = useClock();
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t bg-[color-mix(in_oklab,var(--chart-2)_22%,transparent)]">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(GRID, "w-full py-1.5 text-left text-sm")}>
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="flex items-center gap-2 font-medium">
          <Send className="size-4 shrink-0" aria-hidden />
          {t("message.debug.path.sent")}
        </span>
        <span className="whitespace-nowrap font-mono text-xs">{dateTime(t0 + at, locale)}</span>
        <span className="text-right font-mono text-xs font-medium">{sinceT0(at, locale)}</span>
        <span />
        <span />
        <span />
        <span />
        <span />
      </button>
      {open && (
        <div className="pb-3 pl-9 pr-2">
          <p className="mb-1 text-xs text-muted-foreground">{t("message.debug.path.deliveredText")}</p>
          <pre className="whitespace-pre-wrap break-words rounded-md border bg-background p-3 font-sans text-sm">{text}</pre>
        </div>
      )}
    </div>
  );
}

type Entry =
  | { kind: "hook"; at: number; run: PathHookRun }
  | { kind: "agent"; at: number; call: PathModelCall; last: boolean }
  | { kind: "system"; at: number; call: PathModelCall }
  | { kind: "sent"; at: number };

export function RequestPath({
  debug,
  path,
  conversationId,
  messageId,
  instanceId,
}: {
  debug: MessageDebug;
  path: Path;
  conversationId: string;
  messageId: string;
  instanceId: string;
}) {
  const { t, locale } = useI18n();
  const fmt = useFormat();
  const firstStart = Math.min(
    ...[...path.modelCalls.map((c) => ms(c.startedAt)), ...path.hookRuns.map((h) => ms(h.startedAt))].filter((v): v is number => v !== null),
  );
  // t0 is when the engine took the message up; a turn whose trace was not written starts at its first run.
  const t0 = ms(path.turnStartedAt) ?? (Number.isFinite(firstStart) ? firstStart : 0);

  // Calls a hook or a tool made nest under the run; the rest stand on their own.
  const nested = new Map<string, PathModelCall[]>();
  const own: PathModelCall[] = [];
  for (const call of path.modelCalls) {
    if (call.parentRef) nested.set(call.parentRef, [...(nested.get(call.parentRef) ?? []), call]);
    else own.push(call);
  }
  const agentCalls = own.filter((c) => c.callType === "conversation");
  const lastAgent = agentCalls[agentCalls.length - 1];
  const sentAt = offsetOf(path.replySentAt, t0);

  const entries: Entry[] = [
    ...path.hookRuns.map((run): Entry => ({ kind: "hook", at: offsetOf(run.startedAt, t0) ?? 0, run })),
    ...own.map((call): Entry =>
      call.callType === "conversation"
        ? { kind: "agent", at: offsetOf(call.startedAt, t0) ?? 0, call, last: call === lastAgent }
        : { kind: "system", at: offsetOf(call.startedAt, t0) ?? 0, call },
    ),
    ...(sentAt !== null ? [{ kind: "sent", at: sentAt } as Entry] : []),
  ].sort((a, b) => a.at - b.at || (a.kind === "sent" ? 1 : 0) - (b.kind === "sent" ? 1 : 0));

  const ends = [
    ...path.modelCalls.map((c) => (offsetOf(c.startedAt, t0) ?? 0) + c.durationMs),
    ...path.hookRuns.map((h) => (offsetOf(h.startedAt, t0) ?? 0) + h.durationMs),
    sentAt ?? 0,
  ];
  const span = Math.max(1, ...ends);
  const total = path.modelCalls.reduce((sum, c) => sum + c.costUsd, 0);
  const streaming = debug.turn?.streaming ?? false;

  return (
    <Clock.Provider value={{ conversationId, messageId, instanceId, t0, span, sentAt, locale }}>
      <section className="mt-4 flex flex-col">
        <div className="flex items-baseline justify-between gap-4 border-t pt-3">
          <h3 className="text-sm font-medium">{t("message.debug.path.title")}</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("message.debug.path.arrived", { time: dateTime(t0, locale), cost: fmt.currency(total) })}
          </span>
        </div>
        <div className={cn(GRID, "mt-2 py-1 text-xs text-muted-foreground")}>
          <span />
          <span />
          <span>{t("message.debug.path.time")}</span>
          <span className="text-right">{t("message.debug.path.sinceT0")}</span>
          <span>{t("message.debug.path.timeline", { span: formatLatency(span) })}</span>
          <span className="text-right">{t("message.debug.callDuration")}</span>
          <span className="text-right">{t("message.debug.path.tokensInOut")}</span>
          <span className="text-right">{t("message.debug.usageCost")}</span>
          <span className="text-right">{t("message.debug.callOutcome")}</span>
        </div>
        {entries.map((e, i) =>
          e.kind === "hook" ? (
            <HookRow key={e.run.id} run={e.run} nested={nested.get(e.run.id) ?? []} t0={t0} />
          ) : e.kind === "agent" ? (
            <AgentCall
              key={e.call.id}
              call={e.call}
              steps={e.last ? debug.steps : null}
              nested={nested}
              t0={t0}
              policy={path.intermediateText}
              streaming={streaming}
            />
          ) : e.kind === "system" ? (
            <SystemCall key={e.call.id} call={e.call} t0={t0} />
          ) : (
            <SentRow key={`sent-${i}`} at={e.at} text={path.deliveredText ?? debug.content} />
          ),
        )}
      </section>
    </Clock.Provider>
  );
}
