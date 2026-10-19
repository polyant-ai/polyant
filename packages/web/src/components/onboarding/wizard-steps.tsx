// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useRef } from "react";
import { Check, Send, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ModelsResponse, WizardStepId } from "@/lib/api-types";
import { useI18n } from "@/lib/i18n/context";
import { providerFields, toSlug as toSlugLocal, type WizardDraft } from "@/lib/onboarding/wizard-actions";
import { providerName } from "@/lib/provider-secrets";
import { cn } from "@/lib/utils";

export interface AgentRef {
  slug: string;
  name: string;
}

export interface WebState {
  loaded: boolean;
  enabled: boolean;
  authEnabled: boolean;
  keyConfigured: boolean;
  /** The key generated in this session; shown once, never read back. */
  freshKey: string | null;
}

export interface ChatLine {
  role: "user" | "assistant";
  content: string;
}

export interface StepProps {
  draft: WizardDraft;
  patchDraft: (patch: Partial<WizardDraft>) => void;
  models: ModelsResponse | null;
  modelsFailed: boolean;
  agent: AgentRef | null;
  agentOptions: AgentRef[];
  pickAgent: (slug: string) => void;
  busy: boolean;
  error: string | null;
  goTo: (id: WizardStepId) => void;
  onCreateAgent: () => void;
  web: WebState;
  channelsLink: string;
  onToggleWeb: (on: boolean) => void;
  onToggleAuth: (on: boolean) => void;
  onRegenerateKey: () => void;
  chat: {
    lines: ChatLine[];
    sending: boolean;
    send: (text: string) => void;
  };
  kb: { title: string; text: string; added: boolean; setTitle: (v: string) => void; setText: (v: string) => void; add: () => void };
}

function Blocked({ message, action, onAction }: { message: string; action: string; onAction: () => void }) {
  return (
    <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
      <p>{message}</p>
      <Button size="sm" variant="outline" className="mt-3" onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}

/** Steps that act on an agent: with none yet, offer an existing one or the way to create it. */
function AgentGate({ p, children }: { p: StepProps; children: React.ReactNode }) {
  const { t } = useI18n();
  if (p.agent) return <>{children}</>;
  return (
    <div className="space-y-4">
      <Blocked
        message={t("onboarding.wizard.needAgent")}
        action={t("onboarding.wizard.goCreateAgent")}
        onAction={() => p.goTo("agent")}
      />
      {p.agentOptions.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor="wizard-pick-agent">{t("onboarding.wizard.useExisting")}</Label>
          <Select onValueChange={p.pickAgent}>
            <SelectTrigger id="wizard-pick-agent" className="w-full max-w-sm">
              <SelectValue placeholder={t("onboarding.wizard.pickAgent")} />
            </SelectTrigger>
            <SelectContent>
              {p.agentOptions.map((a) => (
                <SelectItem key={a.slug} value={a.slug}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

function StepHeading({ id, optional }: { id: WizardStepId; optional?: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <h2 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
        {t(`onboarding.step.${id}.heading`)}
        {optional && <Badge variant="secondary">{t("onboarding.wizard.optional")}</Badge>}
      </h2>
      <p className="mt-1 text-muted-foreground">{t(`onboarding.step.${id}.lead`)}</p>
    </>
  );
}

function WelcomeStep() {
  const { t } = useI18n();
  const chain = [t("onboarding.welcome.org"), t("onboarding.welcome.workspace"), t("onboarding.welcome.agent")];
  const cards: [string, string][] = [
    [t("onboarding.welcome.cardAgent"), t("onboarding.welcome.cardAgentBody")],
    [t("onboarding.welcome.cardModel"), t("onboarding.welcome.cardModelBody")],
    [t("onboarding.welcome.cardChannels"), t("onboarding.welcome.cardChannelsBody")],
  ];
  return (
    <div>
      <StepHeading id="welcome" />
      <ol className="mt-5 flex flex-wrap items-center gap-2 text-sm" aria-label={t("onboarding.welcome.chainLabel")}>
        {chain.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span className="rounded-full border bg-muted px-3 py-1 font-medium">{label}</span>
            {i < chain.length - 1 && <span aria-hidden className="text-muted-foreground">→</span>}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">{t("onboarding.welcome.chainNote")}</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {cards.map(([title, body]) => (
          <div key={title} className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
      <p className="mt-5 text-sm text-muted-foreground">{t("onboarding.welcome.time")}</p>
    </div>
  );
}

function ProviderStep({ p }: { p: StepProps }) {
  const { t } = useI18n();
  const providers = p.models ? Object.keys(p.models.providers) : [];
  const fields = providerFields(p.draft.provider);
  return (
    <div>
      <StepHeading id="provider" />
      <div className="mt-5 space-y-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t("onboarding.provider.label")}</legend>
          {p.modelsFailed && <p className="text-sm text-destructive">{t("onboarding.wizard.catalogFailed")}</p>}
          <div className="flex flex-wrap gap-2">
            {providers.map((id) => (
              <Chip
                key={id}
                active={p.draft.provider === id}
                size="md"
                aria-pressed={p.draft.provider === id}
                onClick={() => {
                  const list = p.models?.providers[id]?.models ?? [];
                  const pick = list.find((m) => m.tier === "standard") ?? list[0];
                  p.patchDraft({ provider: id, keys: {}, model: pick?.id ?? "" });
                }}
              >
                {providerName(id)}
              </Chip>
            ))}
          </div>
        </fieldset>
        {p.draft.provider && fields.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("onboarding.provider.unknownKeys")}</p>
        )}
        {fields.map((field) => (
          <div key={field.key} className="max-w-md space-y-1.5">
            <Label htmlFor={`wizard-key-${field.key}`}>{t(field.labelKey)}</Label>
            <Input
              id={`wizard-key-${field.key}`}
              type={field.sensitive === false ? "text" : "password"}
              autoComplete="off"
              value={p.draft.keys[field.key] ?? ""}
              onChange={(e) => p.patchDraft({ keys: { ...p.draft.keys, [field.key]: e.target.value } })}
            />
          </div>
        ))}
        {fields.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {p.draft.provider === "bedrock" ? t("onboarding.provider.awsHint") : t("onboarding.provider.keyHint")}
          </p>
        )}
        <p className="text-sm text-muted-foreground">{t("onboarding.provider.skipNote")}</p>
      </div>
    </div>
  );
}

function ModelStep({ p }: { p: StepProps }) {
  const { t } = useI18n();
  const list = p.models?.providers[p.draft.provider]?.models ?? [];
  return (
    <div>
      <StepHeading id="model" />
      <div className="mt-5">
        {!p.draft.provider ? (
          <Blocked
            message={t("onboarding.model.needProvider")}
            action={t("onboarding.model.goProvider")}
            onAction={() => p.goTo("provider")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("modelTasks.columnTask")}</TableHead>
                <TableHead>{t("settings.tab.provider")}</TableHead>
                <TableHead>{t("onboarding.model.model")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">{t("settings.role.chat.title")}</TableCell>
                <TableCell>{providerName(p.draft.provider)}</TableCell>
                <TableCell>
                  <Select value={p.draft.model} onValueChange={(model) => p.patchDraft({ model })}>
                    <SelectTrigger aria-label={t("onboarding.model.model")} className="w-full min-w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {list.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>{t("settings.role.embed.title")}</TableCell>
                <TableCell colSpan={2} className="text-muted-foreground">{t("onboarding.model.later")}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>{t("settings.role.stt.title")}</TableCell>
                <TableCell colSpan={2} className="text-muted-foreground">{t("onboarding.model.later")}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{t("onboarding.model.help")}</p>
      </div>
    </div>
  );
}

function AgentStep({ p }: { p: StepProps }) {
  const { t } = useI18n();
  if (p.agent) {
    return (
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{t("onboarding.agent.created")}</h2>
        <p className="mt-1 text-muted-foreground">
          {p.agent.name} · <code className="rounded bg-muted px-1.5 py-0.5 text-sm">{p.agent.slug}</code>
        </p>
        <div className="mt-4 rounded-lg border bg-muted/40 p-4 text-sm">{t("onboarding.agent.createdNote")}</div>
      </div>
    );
  }
  const valid = p.draft.name.trim().length > 0 && p.draft.slug.length > 0;
  return (
    <div>
      <StepHeading id="agent" />
      <form
        className="mt-5 max-w-xl space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !p.busy) p.onCreateAgent();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="wizard-name">{t("instances.table.name")}</Label>
          <Input
            id="wizard-name"
            value={p.draft.name}
            placeholder={t("instances.create.namePlaceholder")}
            onChange={(e) =>
              p.patchDraft({
                name: e.target.value,
                ...(p.draft.slugEdited ? {} : { slug: toSlugLocal(e.target.value) }),
              })
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wizard-slug">{t("instances.table.slug")}</Label>
          <Input
            id="wizard-slug"
            value={p.draft.slug}
            onChange={(e) => p.patchDraft({ slug: toSlugLocal(e.target.value), slugEdited: true })}
          />
          <p className="text-xs text-muted-foreground">{t("instances.create.slugHelp")}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wizard-description">{t("instances.table.description")}</Label>
          <Input
            id="wizard-description"
            value={p.draft.description}
            placeholder={t("instances.create.descriptionPlaceholder")}
            onChange={(e) => p.patchDraft({ description: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wizard-instructions">{t("onboarding.agent.instructions")}</Label>
          <Textarea
            id="wizard-instructions"
            rows={5}
            value={p.draft.instructions}
            placeholder={t("onboarding.agent.instructionsPlaceholder")}
            onChange={(e) => p.patchDraft({ instructions: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">{t("onboarding.agent.instructionsHint")}</p>
        </div>
        {p.error && <p role="alert" className="text-sm text-destructive">{p.error}</p>}
        <Button type="submit" disabled={!valid || p.busy}>
          {p.busy ? t("instances.create.creating") : t("onboarding.agent.create")}
        </Button>
      </form>
    </div>
  );
}

function ChannelsStep({ p }: { p: StepProps }) {
  const { t } = useI18n();
  return (
    <div>
      <StepHeading id="channels" />
      <div className="mt-5">
        <AgentGate p={p}>
          <div className="space-y-4">
            <div className="divide-y rounded-lg border px-4">
              <div className="flex items-center justify-between gap-4 py-3">
                <div>
                  <Label htmlFor="wizard-web">{t("channels.tab.web")}</Label>
                  <p className="text-sm text-muted-foreground">{t("onboarding.channels.webHelp")}</p>
                </div>
                <Switch id="wizard-web" checked={p.web.enabled} disabled={!p.web.loaded || p.busy} onCheckedChange={p.onToggleWeb} />
              </div>
              {p.web.enabled && (
                <div className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <Label htmlFor="wizard-auth">{t("settings.tab.authEnabled")}</Label>
                    <p className="text-sm text-muted-foreground">{t("onboarding.channels.authHelp")}</p>
                  </div>
                  <Switch id="wizard-auth" checked={p.web.authEnabled} disabled={p.busy} onCheckedChange={p.onToggleAuth} />
                </div>
              )}
            </div>
            {p.web.enabled && !p.web.authEnabled && (
              <div role="alert" className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>{t("onboarding.channels.riskNotice")}</p>
              </div>
            )}
            {p.web.enabled && p.web.authEnabled && (
              <div className="space-y-2">
                {p.web.freshKey ? (
                  <>
                    <Label htmlFor="wizard-agent-key">{t("settings.tab.authApiKey")}</Label>
                    <div className="flex gap-2">
                      <Input id="wizard-agent-key" readOnly value={p.web.freshKey} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                      <CopyButton value={p.web.freshKey} label={t("onboarding.channels.copy")} variant="outline" />
                    </div>
                    <p className="text-xs text-muted-foreground">{t("onboarding.channels.keyOnce")}</p>
                  </>
                ) : p.web.keyConfigured ? (
                  <p className="text-sm text-muted-foreground">{t("onboarding.channels.keyExists")}</p>
                ) : null}
                <Button type="button" variant="outline" size="sm" disabled={p.busy} onClick={p.onRegenerateKey}>
                  {t("onboarding.channels.regenerate")}
                </Button>
              </div>
            )}
            {p.error && <p role="alert" className="text-sm text-destructive">{p.error}</p>}
            <p className="text-sm text-muted-foreground">
              {t("onboarding.channels.others")}{" "}
              <Link href={p.channelsLink} className="underline underline-offset-2">{t("onboarding.channels.othersLink")}</Link>
            </p>
          </div>
        </AgentGate>
      </div>
    </div>
  );
}

function ChatStep({ p }: { p: StepProps }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [p.chat.lines]);
  return (
    <div>
      <StepHeading id="chat" />
      <div className="mt-5">
        <AgentGate p={p}>
          <div className="space-y-3">
            <div
              ref={log}
              role="log"
              aria-live="polite"
              aria-label={t("onboarding.chat.log")}
              className="h-64 space-y-2 overflow-y-auto rounded-lg border bg-muted/30 p-3"
            >
              {p.chat.lines.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("onboarding.chat.empty")}</p>
              )}
              {p.chat.lines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                    line.role === "user" ? "ml-auto bg-primary text-primary-foreground" : "bg-card border",
                  )}
                >
                  {line.content || "…"}
                </div>
              ))}
            </div>
            {p.error && <p role="alert" className="text-sm text-destructive">{p.error}</p>}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const value = input.current?.value.trim() ?? "";
                if (!value || p.chat.sending) return;
                p.chat.send(value);
                if (input.current) input.current.value = "";
              }}
            >
              <Input ref={input} aria-label={t("onboarding.chat.placeholder")} placeholder={t("onboarding.chat.placeholder")} autoComplete="off" />
              <Button type="submit" disabled={p.chat.sending}>
                <Send className="size-4" />
                <span className="sr-only sm:not-sr-only">{t("onboarding.chat.send")}</span>
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t("onboarding.chat.hint")}</p>
          </div>
        </AgentGate>
      </div>
    </div>
  );
}

function KnowledgeStep({ p }: { p: StepProps }) {
  const { t } = useI18n();
  return (
    <div>
      <StepHeading id="knowledge" optional />
      <div className="mt-5">
        <AgentGate p={p}>
          {p.kb.added ? (
            <p className="flex items-center gap-2 rounded-lg border bg-muted/40 p-4 text-sm">
              <Check className="size-4" aria-hidden /> {t("onboarding.knowledge.added")}
            </p>
          ) : (
            <div className="max-w-xl space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="wizard-kb-title">{t("onboarding.knowledge.title")}</Label>
                <Input id="wizard-kb-title" value={p.kb.title} onChange={(e) => p.kb.setTitle(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wizard-kb-text">{t("onboarding.knowledge.text")}</Label>
                <Textarea id="wizard-kb-text" rows={6} value={p.kb.text} onChange={(e) => p.kb.setText(e.target.value)} />
                <p className="text-xs text-muted-foreground">{t("onboarding.knowledge.hint")}</p>
              </div>
              {p.error && <p role="alert" className="text-sm text-destructive">{p.error}</p>}
              <Button disabled={p.busy || !p.kb.text.trim()} onClick={p.kb.add}>
                {t("onboarding.knowledge.add")}
              </Button>
            </div>
          )}
        </AgentGate>
      </div>
    </div>
  );
}

/** The body of a step, chosen by id: the wizard's step list is data, this is its renderer. */
export function WizardStepBody({ id, p }: { id: WizardStepId; p: StepProps }) {
  switch (id) {
    case "welcome":
      return <WelcomeStep />;
    case "provider":
      return <ProviderStep p={p} />;
    case "model":
      return <ModelStep p={p} />;
    case "agent":
      return <AgentStep p={p} />;
    case "channels":
      return <ChannelsStep p={p} />;
    case "chat":
      return <ChatStep p={p} />;
    case "knowledge":
      return <KnowledgeStep p={p} />;
  }
}
