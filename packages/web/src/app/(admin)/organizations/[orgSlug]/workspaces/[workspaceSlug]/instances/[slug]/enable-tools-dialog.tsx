// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ToolState } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { humanizeSecretKey } from "@/components/instance-secret/secret-spec-field";
import {
  categoryLabel,
  descriptionSummary,
  missingRequiredSpecs,
  pluginNamespaceOf,
  toolDisplayName,
} from "./tools-tab-helpers";

type GroupBy = "category" | "plugin";

/** The key of the built-in group when browsing by plugin. */
const CORE_GROUP = "";

interface Group {
  key: string;
  title: string;
  tools: ToolState[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every tool this agent may enable; always-enabled ones are left out by the caller. */
  tools: readonly ToolState[];
  isEnabled: (name: string) => boolean;
  /** How a plugin is named, and its own sentence about itself when it has one. */
  pluginName: (namespace: string) => string;
  pluginDescription: (namespace: string) => string | null;
  /** `null` while the caller cannot tell (secrets unreadable or loading): no "will ask for" hints then. */
  isConfigured: ((key: string) => boolean) | null;
  onEnable: (names: string[]) => void;
}

/**
 * The catalogue, browsed by category or by plugin. The two are lenses on the
 * same list of tools: a selection survives switching between them, and what is
 * selected is always a set of tools — a plugin is never the thing enabled.
 */
export function EnableToolsDialog({
  open,
  onOpenChange,
  tools,
  isEnabled,
  pluginName,
  pluginDescription,
  isConfigured,
  onEnable,
}: Props) {
  const { t } = useI18n();
  const [groupBy, setGroupBy] = useState<GroupBy>("category");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // Closing clears it, so each opening is a fresh start: a half-made selection
  // from last time is not something anyone expects to find.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setQuery("");
      setActiveGroup(null);
    }
    onOpenChange(next);
  };

  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, ToolState[]>();
    for (const tool of tools) {
      const key = groupBy === "plugin" ? (pluginNamespaceOf(tool.name) ?? CORE_GROUP) : tool.category;
      byKey.set(key, [...(byKey.get(key) ?? []), tool]);
    }
    const title = (key: string) =>
      groupBy === "plugin" ? (key === CORE_GROUP ? t("tools.originCoreGroup") : pluginName(key)) : categoryLabel(key);
    return [...byKey.entries()]
      .map(([key, groupTools]) => ({ key, title: title(key), tools: groupTools }))
      .sort((a, b) => Number(a.key === CORE_GROUP) - Number(b.key === CORE_GROUP) || a.title.localeCompare(b.title));
  }, [tools, groupBy, t, pluginName]);

  const currentKey = activeGroup !== null && groups.some((g) => g.key === activeGroup) ? activeGroup : groups[0]?.key;
  const needle = query.trim().toLowerCase();
  const visibleGroups = needle
    ? groups
        .map((g) => ({
          ...g,
          tools: g.tools.filter((tool) => `${tool.name} ${tool.description} ${g.title}`.toLowerCase().includes(needle)),
        }))
        .filter((g) => g.tools.length > 0)
    : groups.filter((g) => g.key === currentKey);

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const confirm = () => {
    if (selected.size === 0) return;
    onEnable([...selected]);
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName="bg-background/40 backdrop-blur-md"
        className="flex h-[min(640px,calc(100dvh-2rem))] flex-col gap-0 p-0 sm:max-w-4xl"
      >
        <DialogHeader className="border-b p-5 pb-4">
          <DialogTitle>{t("tools.pickerTitle")}</DialogTitle>
          <DialogDescription>{t("tools.pickerDescription")}</DialogDescription>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Tabs value={groupBy} onValueChange={(v) => { setGroupBy(v as GroupBy); setActiveGroup(null); }}>
              <TabsList>
                <TabsTrigger value="category">{t("tools.pickerByCategory")}</TabsTrigger>
                <TabsTrigger value="plugin">{t("tools.pickerByPlugin")}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative min-w-48 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("tools.pickerSearch")}
                aria-label={t("tools.pickerSearch")}
                className="pl-9"
              />
            </div>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[13rem_minmax(0,1fr)]">
          <nav className="flex max-h-32 flex-wrap gap-0.5 overflow-y-auto border-b p-2 sm:max-h-none sm:flex-col sm:flex-nowrap sm:border-r sm:border-b-0">
            {groups.map((group) => {
              const off = group.tools.filter((tool) => !isEnabled(tool.name)).length;
              return (
                <button
                  key={group.key || "core"}
                  type="button"
                  onClick={() => { setActiveGroup(group.key); setQuery(""); }}
                  aria-current={!needle && group.key === currentKey ? "true" : undefined}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted/60",
                    !needle && group.key === currentKey && "bg-muted font-medium",
                  )}
                >
                  <span className="truncate">{group.title}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {off > 0 ? off : <Check className="size-3.5" aria-label={t("tools.pickerAllEnabled")} />}
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 overflow-y-auto p-3">
            {visibleGroups.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">{t("tools.pickerNoMatch", { query })}</p>
            ) : (
              visibleGroups.map((group) => (
                <section key={group.key || "core"} className="mb-4">
                  <div className="px-2 pt-2 pb-1">
                    <h3 className="text-sm font-medium">{group.title}</h3>
                    <p className="text-xs text-muted-foreground">
                      {(groupBy === "plugin" && group.key !== CORE_GROUP && pluginDescription(group.key)) ||
                        t("tools.pickerCount", { count: group.tools.length })}
                    </p>
                  </div>
                  <ul>
                    {group.tools.map((tool) => {
                      const already = isEnabled(tool.name);
                      const id = `pick-${tool.name}`;
                      const willAsk = isConfigured && !already
                        ? missingRequiredSpecs(tool, isConfigured).map((s) => s.label ?? humanizeSecretKey(s.key))
                        : [];
                      const namespace = pluginNamespaceOf(tool.name);
                      return (
                        <li key={tool.name}>
                          <label
                            htmlFor={id}
                            className={cn(
                              "flex gap-3 rounded-md px-2 py-2.5",
                              already ? "cursor-default" : "cursor-pointer hover:bg-muted/60",
                            )}
                          >
                            <Checkbox
                              id={id}
                              className="mt-0.5"
                              checked={already || selected.has(tool.name)}
                              disabled={already}
                              onCheckedChange={() => toggle(tool.name)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className={cn("font-mono text-sm", already && "text-muted-foreground")}>
                                {toolDisplayName(tool.name)}
                              </span>
                              {already && (
                                <span className="text-xs text-muted-foreground"> · {t("tools.pickerAlreadyEnabled")}</span>
                              )}
                              <span className="block text-sm text-muted-foreground">{descriptionSummary(tool.description)}</span>
                              {groupBy === "category" && namespace && (
                                <span className="block text-xs text-muted-foreground">{pluginName(namespace)}</span>
                              )}
                              {willAsk.length > 0 && (
                                <span className="mt-1 block text-xs text-warning">
                                  {t("tools.pickerWillAsk", { names: willAsk.join(", ") })}
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            )}
          </div>
        </div>

        <DialogFooter className="items-center border-t p-4 sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {selected.size > 0 ? t("tools.pickerSelected", { count: selected.size }) : t("tools.pickerSelectHint")}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={confirm} disabled={selected.size === 0}>
              {selected.size > 0 ? t("tools.pickerConfirm", { count: selected.size }) : t("tools.enable")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
