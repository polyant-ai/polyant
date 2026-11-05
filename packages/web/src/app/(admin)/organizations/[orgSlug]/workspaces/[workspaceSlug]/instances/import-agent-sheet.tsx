// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ListDrawer } from "@/components/list-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function names(value: unknown, field: string): string[] {
  return list(value)
    .map((item) => (typeof item === "string" ? item : (item as Record<string, unknown> | null)?.[field]))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * What the file brings, one row per agent section that has something, labelled
 * as the agent's sidebar labels it so the person finds it there afterwards.
 */
function contentRows(instance: AgentBundle["instance"]): { labelKey: TranslationKey; items: string[] }[] {
  const rows: { labelKey: TranslationKey; items: string[] }[] = [
    { labelKey: "instances.detail.tabPrompts", items: names(instance.prompts, "title") },
    { labelKey: "instances.detail.tabChannels", items: names(instance.channels, "channelType") },
    { labelKey: "instances.detail.tabSkills", items: names(instance.skills, "skillSlug") },
    { labelKey: "instances.detail.tabTools", items: names(instance.manualTools, "") },
    { labelKey: "instances.detail.tabMcp", items: names(instance.mcpServers, "name") },
    { labelKey: "instances.detail.tabHooks", items: names(instance.hooks, "event") },
    { labelKey: "triggers.webhooks", items: names(instance.eventSources, "name") },
    { labelKey: "triggers.scheduled", items: names(instance.scheduledTasks, "name") },
    { labelKey: "exportImport.importNew.secrets", items: names(instance.secrets, "key") },
  ];
  return rows.filter((row) => row.items.length > 0);
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
  const provider = typeof instance.provider === "string" ? instance.provider : null;
  const model = typeof instance.model === "string" ? instance.model : null;
  const description = typeof instance.description === "string" ? instance.description : null;
  const room = instance.room as { enabled?: unknown } | null | undefined;
  const rows = contentRows(instance);

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

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("exportImport.importNew.contentTitle")}</h3>
        <dl className="space-y-2 rounded-lg border bg-muted/50 p-4 text-sm">
          {description && (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">{t("instances.table.description")}</dt>
              <dd className="text-right">{description}</dd>
            </div>
          )}
          {(provider || model) && (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">{t("instances.detail.tabSettings")}</dt>
              <dd className="text-right">{[provider, model].filter(Boolean).join(" · ")}</dd>
            </div>
          )}
          {rows.map((row) => (
            <div key={row.labelKey} className="flex justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">{t(row.labelKey)}</dt>
              <dd className="min-w-0 text-right">
                <span className="font-medium">{row.items.length}</span>
                <span className="block truncate text-xs text-muted-foreground" title={row.items.join(", ")}>
                  {row.items.join(", ")}
                </span>
              </dd>
            </div>
          ))}
          {room?.enabled === true && (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">{t("instances.detail.tabRoom")}</dt>
              <dd className="text-right">{t("exportImport.importNew.roomEnabled")}</dd>
            </div>
          )}
        </dl>
        <p className="text-xs text-muted-foreground">{t("exportImport.importNew.reviewInfo")}</p>
      </section>
    </ListDrawer>
  );
}
