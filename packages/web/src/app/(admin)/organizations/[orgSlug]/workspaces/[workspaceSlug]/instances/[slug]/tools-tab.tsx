// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ChevronRight, MinusCircle, Plus, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, getUserErrorMessage, type ToolState, type SkillState, type ToolPluginInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { humanizeSecretKey } from "@/components/instance-secret/secret-spec-field";
import { useSecretSpecs } from "@/components/instance-secret/use-secret-specs";
import { usePageSaveAction } from "./page-actions-context";
import { ToolSheet } from "./tool-sheet";
import { EnableToolsDialog } from "./enable-tools-dialog";
import {
  categoryLabel,
  descriptionSummary,
  missingRequiredSpecs,
  pluginDescription,
  pluginName,
  pluginNamespaceOf,
  toolDisplayName,
  uniqueSpecs,
} from "./tools-tab-helpers";

interface Props {
  slug: string;
  tools: ToolState[];
  skills: SkillState[];
  memoryEnabled: boolean;
  knowledgeEnabled: boolean;
  /** How each plugin the tools come from is named, from its manifest. */
  plugins?: ToolPluginInfo[];
  onToolsUpdate: (tools: ToolState[]) => void;
  onSkillsUpdate: (skills: SkillState[]) => void;
  /** Called after a save that wrote parameter values, so the status checks re-read them. */
  onConfigurationChanged?: () => void;
}

/** The Origin filter's value for built-in tools; a plugin is filtered by its namespace. */
const CORE_ORIGIN = "";

interface PendingDisable {
  tool: string;
  /** An enabled skill that needs this tool and is switched off with it. */
  skill: string | null;
}

/**
 * What this agent can do: the tools it has, one row each, and a picker to enable
 * more. The unit is always one tool — a plugin groups tools and filters the
 * list, it is never switched as a whole.
 *
 * Enabling and disabling (confirmed first, since the agent loses an action) are a
 * draft until the page's Save; a row about to change stays visible and says so.
 * Parameter values are not in that draft: a key belongs to the agent, not to the
 * switch, so the tool's panel saves them with its own button, even for a tool
 * that is still only drafted.
 */
export function ToolsTab({
  slug,
  tools,
  skills,
  memoryEnabled,
  knowledgeEnabled,
  plugins = [],
  onToolsUpdate,
  onSkillsUpdate,
  onConfigurationChanged,
}: Props) {
  const { t } = useI18n();
  const nameOfPlugin = (namespace: string) => pluginName(namespace, plugins);
  const aboutPlugin = (namespace: string) => pluginDescription(namespace, plugins);

  const [toolToggles, setToolToggles] = useState<Record<string, boolean>>({});
  const [skillToggles, setSkillToggles] = useState<Record<string, boolean>>({});
  /** Skills switched off by a confirmed disable, keyed by the tool that took them: Restore brings both back. */
  const [cascaded, setCascaded] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [originFilter, setOriginFilter] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingDisable, setPendingDisable] = useState<PendingDisable | null>(null);

  const specs = useMemo(() => uniqueSpecs(tools), [tools]);
  const params = useSecretSpecs(slug, specs);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const savedEnabled = useMemo(() => new Map(tools.map((tool) => [tool.name, tool.enabled])), [tools]);
  const skillEnabledMap = useMemo(() => new Map(skills.map((s) => [s.name, s.enabled])), [skills]);

  const isSaved = (name: string) => savedEnabled.get(name) ?? false;
  const isEnabled = (name: string) => toolToggles[name] ?? isSaved(name);
  const getSkillEnabled = (name: string) => skillToggles[name] ?? skillEnabledMap.get(name) ?? false;

  const toolToSkillDeps = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const skill of skills) {
      for (const toolName of skill.requiredTools ?? []) {
        map.set(toolName, [...(map.get(toolName) ?? []), skill.name]);
      }
    }
    return map;
  }, [skills]);

  const toolsDirty = Object.keys(toolToggles).some((name) => toolToggles[name] !== isSaved(name));
  const skillsDirty = Object.keys(skillToggles).some((name) => skillToggles[name] !== skillEnabledMap.get(name));
  // Parameters are not part of this draft: the tool's panel saves them itself.
  const isDirty = toolsDirty || skillsDirty;

  // A tool the engine keeps on whatever this page says. Listed last, without actions.
  const alwaysOn = tools.filter((tool) => tool.source === "global");
  // What the table lists: enabled now, or enabled when saved (a row pending removal stays).
  const listed = tools.filter((tool) => tool.source !== "global" && (isSaved(tool.name) || isEnabled(tool.name)));
  const catalogue = tools.filter((tool) => tool.source !== "global");

  const originOptions = [...new Set(listed.map((tool) => pluginNamespaceOf(tool.name) ?? CORE_ORIGIN))].sort(
    (a, b) => Number(a === CORE_ORIGIN) - Number(b === CORE_ORIGIN) || a.localeCompare(b),
  );
  const categoryOptions = [...new Set([...listed, ...alwaysOn].map((tool) => tool.category))].sort();
  const originName = (origin: string) => (origin === CORE_ORIGIN ? t("tools.originCore") : nameOfPlugin(origin));

  const needle = search.trim().toLowerCase();
  const matches = (tool: ToolState) =>
    (!needle || `${tool.name} ${tool.description}`.toLowerCase().includes(needle)) &&
    (originFilter === null || (pluginNamespaceOf(tool.name) ?? CORE_ORIGIN) === originFilter) &&
    (categoryFilter === null || tool.category === categoryFilter);
  const rows = listed.filter(matches).sort((a, b) => a.name.localeCompare(b.name));
  const systemRows = alwaysOn.filter(matches);

  /** Why an enabled tool does nothing even while enabled: a layer it depends on is off. */
  const lockReason = (tool: ToolState): string | null => {
    if (!memoryEnabled && tool.category === "memory") return t("tools.memoryDisabledHint");
    if (!knowledgeEnabled && tool.category === "knowledge") return t("tools.knowledgeDisabledHint");
    return null;
  };
  /** What the warning beside a row's actions says, or null for a tool that will run. */
  const warningFor = (tool: ToolState): string | null => {
    const locked = lockReason(tool);
    if (locked) return locked;
    // "Unknown" must not read as "missing": no warning while the keys cannot be read.
    if (params.loading || !params.canRead) return null;
    const missing = missingRequiredSpecs(tool, params.isConfigured);
    return missing.length > 0
      ? t("tools.missingParams", { names: missing.map((s) => s.label ?? humanizeSecretKey(s.key)).join(", ") })
      : null;
  };

  // ---------------------------------------------------------------------------
  // Draft changes
  // ---------------------------------------------------------------------------

  const setToggle = (name: string, enabled: boolean) =>
    setToolToggles((prev) => {
      const next = { ...prev };
      if (enabled === isSaved(name)) delete next[name];
      else next[name] = enabled;
      return next;
    });

  function restore(name: string) {
    setToggle(name, true);
    const skill = cascaded[name];
    if (!skill) return;
    setSkillToggles((prev) => {
      const next = { ...prev };
      delete next[skill];
      return next;
    });
    setCascaded((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  /** `announce` is off from a tool's panel: one switch flipped needs no toast. */
  const enableTools = (names: string[], announce = true) => {
    for (const name of names) restore(name);
    // A tool that cannot run without a value opens straight on its fields.
    const firstMissing = params.canRead && !params.loading
      ? names.find((name) => {
          const tool = tools.find((x) => x.name === name);
          return tool ? missingRequiredSpecs(tool, params.isConfigured).length > 0 : false;
        })
      : undefined;
    if (firstMissing) setOpenTool(firstMissing);
    if (announce) toast.success(t("tools.enabledPending", { count: names.length }));
  };

  /** Disabling a tool the agent has now is confirmed; undoing one that is only drafted is not. */
  const requestDisable = (name: string) => {
    if (!isSaved(name)) {
      setToggle(name, false);
      return;
    }
    const skill = (toolToSkillDeps.get(name) ?? []).find(getSkillEnabled) ?? null;
    setPendingDisable({ tool: name, skill });
  };

  const confirmDisable = () => {
    if (!pendingDisable) return;
    const { tool, skill } = pendingDisable;
    setToggle(tool, false);
    if (skill) {
      setSkillToggles((prev) => ({ ...prev, [skill]: false }));
      setCascaded((prev) => ({ ...prev, [tool]: skill }));
    }
    setPendingDisable(null);
    if (openTool === tool) setOpenTool(null);
    toast.success(t("tools.disabledPending", { tool: toolDisplayName(tool) }));
  };

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  const handleSave = async () => {
    setSaving(true);
    try {
      // A disable that took a skill with it writes the skill first: the engine
      // refuses to keep a skill whose required tool is gone.
      if (skillsDirty) {
        const enabledSkills = skills.filter((s) => getSkillEnabled(s.name)).map((s) => s.name);
        const result = await api.skills.update(slug, enabledSkills);
        onSkillsUpdate(result.skills);
        setSkillToggles({});
        setCascaded({});
      }
      if (toolsDirty) {
        const enabledTools = tools.filter((tool) => isEnabled(tool.name)).map((tool) => tool.name);
        const updated = await api.tools.update(slug, enabledTools);
        onToolsUpdate(updated.tools);
        setToolToggles({});
      }
      toast.success(t("tools.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("tools.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const filterPill = (
    label: string,
    value: string | null,
    options: string[],
    optionLabel: (v: string) => string,
    onChange: (v: string | null) => void,
  ) =>
    value !== null ? (
      <Button
        variant="secondary"
        size="sm"
        className="h-7 gap-1 px-2.5 text-xs"
        onClick={() => onChange(null)}
        aria-label={t("tools.filterClear", { filter: label })}
      >
        {label}: {optionLabel(value)}
        <X className="size-3.5" aria-hidden />
      </Button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2.5 text-xs" disabled={options.length === 0}>
            <Plus className="size-3.5" aria-hidden />
            {label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {options.map((option) => (
            <DropdownMenuItem key={option || "core"} onSelect={() => onChange(option)}>
              {optionLabel(option)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );

  const openedTool = openTool ? tools.find((tool) => tool.name === openTool) ?? null : null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-prose text-sm text-muted-foreground">{t("tools.description")}</p>
        <Button onClick={() => setPickerOpen(true)}>{t("tools.enable")}</Button>
      </div>

      {listed.length === 0 && alwaysOn.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t("tools.noneEnabled")}
        </p>
      ) : (
        <>
          <div className="relative mt-8">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("tools.searchEnabled")}
              aria-label={t("tools.searchEnabled")}
              className="pl-9"
            />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {filterPill(t("tools.filterOrigin"), originFilter, originOptions, originName, setOriginFilter)}
            {filterPill(t("tools.filterCategory"), categoryFilter, categoryOptions, categoryLabel, setCategoryFilter)}
          </div>

          {rows.length === 0 && systemRows.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">{t("tools.noMatch")}</p>
          ) : (
            <Table className="mt-4 table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[32%]">{t("tools.columnName")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("tools.columnDescription")}</TableHead>
                  <TableHead className="hidden w-40 sm:table-cell">{t("tools.columnOrigin")}</TableHead>
                  <TableHead className="w-32">
                    <span className="sr-only">{t("tools.columnActions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((tool) => {
                  const adding = isEnabled(tool.name) && !isSaved(tool.name);
                  const removing = !isEnabled(tool.name) && isSaved(tool.name);
                  const warning = removing ? null : warningFor(tool);
                  const namespace = pluginNamespaceOf(tool.name);
                  const linkedSkill = (toolToSkillDeps.get(tool.name) ?? []).find(getSkillEnabled);
                  const subtitle = adding
                    ? t("tools.pendingEnable")
                    : removing
                      ? t("tools.pendingDisable")
                      : [categoryLabel(tool.category), linkedSkill && t("capabilities.linkedToSkill", { skill: linkedSkill })]
                          .filter(Boolean)
                          .join(" · ");
                  return (
                    <TableRow
                      key={tool.name}
                      data-state={openTool === tool.name ? "selected" : undefined}
                      className={cn(
                        "border-0",
                        removing ? "bg-muted/40 hover:bg-muted/40" : "group cursor-pointer",
                        adding && "shadow-[inset_3px_0_0_var(--accent)]",
                      )}
                      onClick={removing ? undefined : () => setOpenTool(tool.name)}
                    >
                      <TableCell className="py-2">
                        {removing ? (
                          <span className="block truncate font-mono text-sm text-muted-foreground line-through">
                            {toolDisplayName(tool.name)}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="block max-w-full truncate text-left font-mono text-sm hover:underline"
                            aria-label={t("tools.open", { tool: tool.name })}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenTool(tool.name);
                            }}
                          >
                            {toolDisplayName(tool.name)}
                          </button>
                        )}
                        <span
                          className={cn(
                            "block truncate",
                            adding || removing ? "text-xs font-medium" : "text-xs text-muted-foreground",
                          )}
                        >
                          {subtitle}
                        </span>
                      </TableCell>
                      <TableCell
                        className={cn("hidden md:table-cell", removing && "text-muted-foreground line-through")}
                      >
                        <span className="block truncate text-sm" title={descriptionSummary(tool.description)}>{descriptionSummary(tool.description)}</span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="secondary" className={cn("max-w-full truncate", removing && "opacity-50")}>
                          {namespace ? nameOfPlugin(namespace) : t("tools.originCore")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-0.5">
                          {removing ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                restore(tool.name);
                              }}
                            >
                              {t("tools.restore")}
                            </Button>
                          ) : (
                            <>
                              {warning && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span
                                      tabIndex={0}
                                      role="img"
                                      aria-label={warning}
                                      className="grid size-8 place-items-center rounded-md text-warning"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <AlertTriangle className="size-4" aria-hidden />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-72">
                                    {warning}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 text-muted-foreground"
                                aria-label={t("tools.disableTool", { tool: tool.name })}
                                title={t("tools.disable")}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestDisable(tool.name);
                                }}
                              >
                                <MinusCircle className="size-4" aria-hidden />
                              </Button>
                              {/* The row opens the tool's panel — its parameters and siblings.
                                  The chevron says so; the name button is what a keyboard or
                                  screen reader uses, so this one stays out of their way. */}
                              <ChevronRight
                                className="ml-1 size-4 text-muted-foreground/60 transition-colors group-hover:text-foreground"
                                aria-hidden
                              />
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {systemRows.map((tool) => (
                  <TableRow key={tool.name} className="border-0 hover:bg-transparent">
                    <TableCell className="py-2">
                      <span className="block truncate font-mono text-sm text-muted-foreground">{tool.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{categoryLabel(tool.category)}</span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      <span className="block truncate text-sm" title={descriptionSummary(tool.description)}>{descriptionSummary(tool.description)}</span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="secondary">{t("tools.originCore")}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            tabIndex={0}
                            className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-4"
                          >
                            {t("tools.alwaysEnabled")}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-72">
                          {tool.requiredBy?.length
                            ? t("tools.requiredBy", { skills: tool.requiredBy.join(", ") })
                            : t("tools.cannotDisable")}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}

      <ToolSheet
        tool={openedTool}
        tools={tools}
        isEnabled={isEnabled}
        pendingEnable={openedTool ? isEnabled(openedTool.name) && !isSaved(openedTool.name) : false}
        lockReason={openedTool ? lockReason(openedTool) : null}
        pluginName={nameOfPlugin}
        params={params}
        onParamsSaved={onConfigurationChanged}
        onEnable={(name) => enableTools([name], false)}
        onDisable={requestDisable}
        onClose={() => setOpenTool(null)}
      />

      <EnableToolsDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        tools={catalogue}
        isEnabled={isEnabled}
        pluginName={nameOfPlugin}
        pluginDescription={aboutPlugin}
        isConfigured={params.loading || !params.canRead ? null : params.isConfigured}
        onEnable={enableTools}
      />

      <AlertDialog open={pendingDisable !== null} onOpenChange={(open) => !open && setPendingDisable(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDisable && t("tools.disableConfirmTitle", { tool: toolDisplayName(pendingDisable.tool) })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDisable?.skill
                ? t("tools.disableConfirmCascade", { skill: pendingDisable.skill })
                : t("tools.disableConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDisable}>
              {pendingDisable?.skill ? t("capabilities.confirm") : t("tools.disable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
