// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ListDrawer } from "@/components/list-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { api, ApiError, getUserErrorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import { toSlug, typingSlug } from "./create-instance-sheet";

/** An exported agent file, as far as the confirmation needs to read it. */
export interface AgentBundle {
  type: "instance";
  instance: Record<string, unknown> & { slug: string; name: string };
}

export type ImportResult = Awaited<ReturnType<typeof api.exportImport.importNew>>;

/** The file's agent, or null when the JSON is not an exported agent. */
export function asAgentBundle(value: unknown): AgentBundle | null {
  if (!value || typeof value !== "object") return null;
  const { type, instance } = value as { type?: unknown; instance?: unknown };
  if (type !== "instance" || !instance || typeof instance !== "object") return null;
  const { slug, name } = instance as { slug?: unknown; name?: unknown };
  if (typeof slug !== "string" || typeof name !== "string") return null;
  return value as AgentBundle;
}

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => !!item && typeof item === "object") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One element of a kind: what it is called, a short qualifier, and its text when it has one. */
interface Entry {
  title: string;
  /** Rendered in monospace: the title is an identifier, not a label. */
  code?: boolean;
  meta?: string;
  body?: string;
}

function scheduleText(schedule: unknown): string {
  const s = (schedule ?? {}) as Row;
  if (s.type === "cron") return text(s.expression);
  if (s.type === "interval" && typeof s.everyMs === "number") return `${Math.round(s.everyMs / 60_000)} min`;
  if (s.type === "one-shot") return text(s.runAt);
  return "";
}

/**
 * What the file brings, one group per agent section that has something, labelled
 * as the agent's sidebar labels it so the person finds it there afterwards.
 */
function contentGroups(
  instance: AgentBundle["instance"],
  t: (key: TranslationKey) => string,
): { key: string; labelKey: TranslationKey; entries: Entry[] }[] {
  const off = (enabled: unknown) => (enabled === false ? t("common.disabled") : undefined);
  const room = instance.room as Row | null | undefined;
  const groups: { key: string; labelKey: TranslationKey; entries: Entry[] }[] = [
    {
      key: "prompts",
      labelKey: "instances.detail.tabPrompts",
      entries: rows(instance.prompts).map((p) => ({
        title: text(p.title) || text(p.sectionKey),
        body: text(p.content).trim() || t("exportImport.importNew.emptyPrompt"),
      })),
    },
    {
      key: "tools",
      labelKey: "instances.detail.tabTools",
      entries: (Array.isArray(instance.manualTools) ? instance.manualTools : [])
        .filter((name): name is string => typeof name === "string")
        .map((name) => ({ title: name, code: true })),
    },
    {
      key: "skills",
      labelKey: "instances.detail.tabSkills",
      entries: rows(instance.skills).map((s) => ({
        title: text(s.skillSlug),
        code: true,
        meta: [text(s.pinnedVersion), off(s.enabled)].filter(Boolean).join(" · ") || undefined,
      })),
    },
    {
      key: "mcp",
      labelKey: "instances.detail.tabMcp",
      entries: rows(instance.mcpServers).map((m) => ({ title: text(m.name), meta: off(m.enabled), body: text(m.url) })),
    },
    {
      key: "hooks",
      labelKey: "instances.detail.tabHooks",
      entries: rows(instance.hooks).map((h) => ({
        title: text(h.event),
        code: true,
        meta: off(h.enabled),
        body: text((h.actionConfig as Row | undefined)?.functionName) || text(h.actionType),
      })),
    },
    {
      key: "webhooks",
      labelKey: "triggers.webhooks",
      entries: rows(instance.eventSources).map((e) => ({
        title: text(e.name),
        meta: [text(e.sourceType), off(e.enabled)].filter(Boolean).join(" · ") || undefined,
        body: rows(e.definitions).map((d) => text(d.name)).filter(Boolean).join(", ") || undefined,
      })),
    },
    {
      key: "scheduled",
      labelKey: "triggers.scheduled",
      entries: rows(instance.scheduledTasks).map((task) => ({
        title: text(task.name),
        meta: [scheduleText(task.schedule), off(task.enabled)].filter(Boolean).join(" · ") || undefined,
        body: text(task.prompt) || undefined,
      })),
    },
    {
      key: "room",
      labelKey: "instances.detail.tabRoom",
      entries:
        room && room.enabled === true
          ? [{ title: t("instances.detail.tabRoom"), body: text(room.prompt) || undefined }]
          : [],
    },
    {
      key: "secrets",
      labelKey: "exportImport.importNew.secrets",
      entries: rows(instance.secrets).map((secret) => ({
        title: text(secret.key),
        code: true,
        meta: typeof secret.value === "string" ? secret.value : t("exportImport.importNew.secretToEnter"),
      })),
    },
  ];
  return groups.filter((group) => group.entries.length > 0);
}

interface Props {
  /** The parsed file. The page remounts the drawer for each file chosen. */
  bundle: AgentBundle;
  open: boolean;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}

/**
 * The confirmation between choosing an exported agent file and creating the
 * agent: what the file brings, and the name and slug the new agent takes. The
 * slug is final once imported, so a taken one is reported here to be changed,
 * never rewritten by the engine.
 */
export function ImportAgentSheet({ bundle, open, onClose, onImported }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState(bundle.instance.name);
  const [slug, setSlug] = useState(bundle.instance.slug);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const isValid = name.trim().length > 0 && toSlug(slug).length > 0;

  const handleOpenChange = (next: boolean) => {
    if (!next && !importing) onClose();
  };

  const handleImport = async () => {
    if (!isValid) return;
    setImporting(true);
    try {
      const result = await api.exportImport.importNew({
        ...bundle,
        instance: { ...bundle.instance, name: name.trim(), slug: toSlug(slug) },
      });
      onImported(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSlugError(t("exportImport.importNew.slugTaken"));
      } else {
        toast.error(getUserErrorMessage(err, t("exportImport.import.failed")));
      }
    } finally {
      setImporting(false);
    }
  };

  const { instance } = bundle;
  const provider = text(instance.provider);
  const model = text(instance.model);
  const description = text(instance.description);
  const embedder = text(instance.embeddingProvider);
  const channels = rows(instance.channels)
    .map((c) => text(c.channelType) + (c.enabled === false ? ` (${t("common.disabled").toLowerCase()})` : ""))
    .filter(Boolean);
  const groups = contentGroups(instance, t);

  return (
    <ListDrawer
      open={open}
      onOpenChange={handleOpenChange}
      title={t("exportImport.importNew.title")}
      description={t("exportImport.importNew.reviewDescription")}
      primary={
        <Button type="submit" form="import-agent-form" disabled={!isValid || importing}>
          {importing ? t("exportImport.import.uploading") : t("exportImport.import.button")}
        </Button>
      }
    >
      <form
        id="import-agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleImport();
        }}
        className="space-y-4"
      >
        <h3 className="text-sm font-medium">{t("exportImport.importNew.sectionAgent")}</h3>
        <div className="space-y-2">
          <Label htmlFor="import-name">{t("instances.table.name")}</Label>
          <Input id="import-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="import-slug">{t("instances.table.slug")}</Label>
          <Input
            id="import-slug"
            value={slug}
            onChange={(e) => {
              setSlug(typingSlug(e.target.value));
              setSlugError(null);
            }}
            aria-invalid={slugError !== null}
            aria-describedby={slugError ? "import-slug-error" : "import-slug-help"}
          />
          {slugError ? (
            <p id="import-slug-error" role="alert" className="text-xs text-destructive">
              {slugError}
            </p>
          ) : (
            <p id="import-slug-help" className="text-xs text-muted-foreground">
              {t("exportImport.importNew.slugHelp")}
            </p>
          )}
        </div>
      </form>

      <section className="space-y-3 border-t pt-6">
        <h3 className="text-sm font-medium">{t("exportImport.importNew.sectionConfiguration")}</h3>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-6 gap-y-3 text-sm">
          {description && (
            <>
              <dt className="text-muted-foreground">{t("instances.table.description")}</dt>
              <dd>{description}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("instances.detail.tabSettings")}</dt>
          <dd>{provider || model ? [provider, model].filter(Boolean).join(" · ") : t("exportImport.importNew.modelDefault")}</dd>
          {embedder && (
            <>
              <dt className="text-muted-foreground">{t("settings.tab.embedder")}</dt>
              <dd>{embedder}</dd>
            </>
          )}
          {channels.length > 0 && (
            <>
              <dt className="text-muted-foreground">{t("instances.detail.tabChannels")}</dt>
              <dd>{channels.join(", ")}</dd>
            </>
          )}
        </dl>
      </section>

      {groups.length > 0 && (
        <section className="space-y-1 border-t pt-6">
          <h3 className="text-sm font-medium">{t("exportImport.importNew.sectionContent")}</h3>
          <Accordion type="multiple">
            {groups.map((group) => (
              <AccordionItem key={group.key} value={group.key}>
                <AccordionTrigger className="py-3 hover:no-underline">
                  <span className="flex flex-1 items-baseline justify-between gap-4">
                    <span>{t(group.labelKey)}</span>
                    <span className="font-normal tabular-nums text-muted-foreground">{group.entries.length}</span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <ul className="space-y-3">
                    {group.entries.map((entry, index) => (
                      <li key={`${entry.title}-${index}`} className="space-y-1">
                        <div className="flex items-baseline justify-between gap-4">
                          <span className={entry.code ? "font-mono text-xs" : "font-medium"}>{entry.title}</span>
                          {entry.meta && (
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">{entry.meta}</span>
                          )}
                        </div>
                        {entry.body && (
                          <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{entry.body}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
          <p className="pt-2 text-xs text-muted-foreground">{t("exportImport.importNew.reviewInfo")}</p>
        </section>
      )}
    </ListDrawer>
  );
}
