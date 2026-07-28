// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, useMemo } from "react";
import { toast } from "sonner";
import { Search, Lock, ChevronDown, Link as LinkIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { api, getUserErrorMessage, type ToolState, type SkillState } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";

// ---------------------------------------------------------------------------
// Props & Types
// ---------------------------------------------------------------------------

interface Props {
  slug: string;
  tools: ToolState[];
  skills: SkillState[];
  memoryEnabled: boolean;
  knowledgeEnabled: boolean;
  onToolsUpdate: (tools: ToolState[]) => void;
  onSkillsUpdate: (skills: SkillState[]) => void;
}

type Filter = "all" | "enabled" | "disabled";

interface CascadeConfirm {
  toolName: string;
  skillName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupToolsByCategory(tools: ToolState[]): Map<string, ToolState[]> {
  const groups = new Map<string, ToolState[]>();
  for (const tool of tools) {
    const cat = tool.source === "global" ? "system" : tool.category;
    const existing = groups.get(cat) ?? [];
    groups.set(cat, [...existing, tool]);
  }
  return new Map(
    [...groups.entries()].sort(([a], [b]) => {
      if (a === "system") return 1;
      if (b === "system") return -1;
      return a.localeCompare(b);
    }),
  );
}

function categoryLabel(cat: string): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ToolsTab({
  slug,
  tools,
  skills,
  memoryEnabled,
  knowledgeEnabled,
  onToolsUpdate,
  onSkillsUpdate,
}: Props) {
  const { t } = useI18n();

  const [toolToggles, setToolToggles] = useState<Record<string, boolean>>({});
  const [skillToggles, setSkillToggles] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const [cascadeConfirm, setCascadeConfirm] = useState<CascadeConfirm | null>(null);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const toolEnabledMap = useMemo(() => new Map(tools.map((t) => [t.name, t.enabled])), [tools]);
  const skillEnabledMap = useMemo(() => new Map(skills.map((s) => [s.name, s.enabled])), [skills]);

  const getToolEnabled = (name: string) => toolToggles[name] ?? toolEnabledMap.get(name) ?? false;
  const getSkillEnabled = (name: string) => skillToggles[name] ?? skillEnabledMap.get(name) ?? false;

  const toolToSkillDeps = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const skill of skills) {
      if (!skill.requiredTools) continue;
      for (const toolName of skill.requiredTools) {
        const existing = map.get(toolName) ?? [];
        existing.push(skill.name);
        map.set(toolName, existing);
      }
    }
    return map;
  }, [skills]);

  const isDirty = useMemo(() => {
    const toolDirty = Object.keys(toolToggles).some((name) =>
      toolToggles[name] !== toolEnabledMap.get(name),
    );
    const skillDirty = Object.keys(skillToggles).some((name) =>
      skillToggles[name] !== skillEnabledMap.get(name),
    );
    return toolDirty || skillDirty;
  }, [toolToggles, skillToggles, toolEnabledMap, skillEnabledMap]);

  const filteredTools = useMemo(() => {
    const q = search.toLowerCase();
    return tools.filter((t) => {
      if (q && !t.name.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) return false;
      const enabled = getToolEnabled(t.name);
      if (filter === "enabled" && !enabled) return false;
      if (filter === "disabled" && enabled) return false;
      return true;
    });
  }, [tools, search, filter, toolToggles, toolEnabledMap]);

  const toolGroups = useMemo(() => groupToolsByCategory(filteredTools), [filteredTools]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleToolToggle = (name: string, enabled: boolean) => {
    if (!enabled) {
      const depSkills = toolToSkillDeps.get(name) ?? [];
      const enabledDepSkill = depSkills.find((s) => getSkillEnabled(s));
      if (enabledDepSkill) {
        setCascadeConfirm({ toolName: name, skillName: enabledDepSkill });
        return;
      }
    }
    setToolToggles((prev) => ({ ...prev, [name]: enabled }));
  };

  const handleCascadeConfirm = () => {
    if (!cascadeConfirm) return;
    setToolToggles((prev) => ({ ...prev, [cascadeConfirm.toolName]: false }));
    setSkillToggles((prev) => ({ ...prev, [cascadeConfirm.skillName]: false }));
    setCascadeConfirm(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // If cascade disabled a skill, save skills first
      const skillDirty = Object.keys(skillToggles).some((name) => {
        const original = skills.find((s) => s.name === name);
        return original && skillToggles[name] !== original.enabled;
      });

      if (skillDirty) {
        const enabledSkills = skills
          .map((s) => ({ name: s.name, enabled: skillToggles[s.name] ?? s.enabled }))
          .filter((s) => s.enabled)
          .map((s) => s.name);
        const result = await api.skills.update(slug, enabledSkills);
        onSkillsUpdate(result.skills);
      }

      const enabledTools = tools
        .map((t) => ({ name: t.name, enabled: toolToggles[t.name] ?? t.enabled }))
        .filter((t) => t.enabled)
        .map((t) => t.name);
      const { tools: updatedTools } = await api.tools.update(slug, enabledTools);
      onToolsUpdate(updatedTools);

      setToolToggles({});
      setSkillToggles({});
      toast.success(t("tools.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("tools.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  const toggleCollapse = (cat: string) => {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const renderToolRow = (tool: ToolState) => {
    const source = tool.source ?? "manual";
    const memoryLocked = !memoryEnabled && tool.category === "memory";
    const knowledgeLocked = !knowledgeEnabled && tool.category === "knowledge";
    const featureLocked = memoryLocked || knowledgeLocked;
    const isGlobal = source === "global";
    const isEnabled = featureLocked ? false : getToolEnabled(tool.name);
    const depSkills = toolToSkillDeps.get(tool.name) ?? [];
    const linkedSkill = depSkills.find((s) => getSkillEnabled(s));

    return (
      <div
        key={tool.name}
        className={`flex items-center justify-between rounded-lg border p-3 px-4 transition-colors ${
          isEnabled ? "bg-background" : "bg-muted/30 opacity-60"
        }`}
      >
        <div className="space-y-0.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{tool.name}</span>
            {linkedSkill && (
              <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                <LinkIcon className="size-3" />
                {t("capabilities.linkedToSkill").replace("{skill}", linkedSkill)}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {memoryLocked
              ? t("tools.memoryDisabledHint")
              : knowledgeLocked
                ? t("tools.knowledgeDisabledHint")
                : tool.description}
          </p>
        </div>
        {isGlobal || featureLocked ? (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock className="size-4 text-muted-foreground/50 shrink-0" />
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{featureLocked ? (memoryLocked ? t("tools.memoryDisabledHint") : t("tools.knowledgeDisabledHint")) : t("tools.cannotDisable")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Switch
            checked={isEnabled}
            onCheckedChange={(checked) => handleToolToggle(tool.name, checked)}
          />
        )}
      </div>
    );
  };

  return (
    <div className="max-w-3xl">
      <p className="mb-4 text-sm text-muted-foreground">
        {t("tools.description")}
      </p>

      {/* Search + Filter */}
      <div className="mb-6 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("capabilities.search")}
            className="pl-9"
          />
        </div>
        <div className="flex gap-1">
          {(["all", "enabled", "disabled"] as Filter[]).map((f) => (
            <Button
              key={f}
              variant={filter === f ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {t(`capabilities.filter${f.charAt(0).toUpperCase() + f.slice(1)}` as "capabilities.filterAll")}
            </Button>
          ))}
        </div>
      </div>

      {/* Grouped tools */}
      {filteredTools.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          {t("capabilities.empty")}
        </p>
      ) : (
        <div className="space-y-4">
          {[...toolGroups.entries()].map(([category, catTools]) => {
            const isCollapsed = collapsedCats.has(category);
            return (
              <Collapsible key={category} open={!isCollapsed} onOpenChange={() => toggleCollapse(category)}>
                <CollapsibleTrigger className="flex w-full items-center gap-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                  <ChevronDown className={`size-4 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                  {category === "system" ? t("capabilities.systemCategory") : categoryLabel(category)}
                  <span className="text-xs font-normal">({catTools.length})</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 space-y-1.5">
                    {catTools.map(renderToolRow)}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}

      {/* Cascade confirm */}
      <AlertDialog open={!!cascadeConfirm} onOpenChange={(open) => !open && setCascadeConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {cascadeConfirm && t("capabilities.disableToolConfirmTitle").replace("{tool}", cascadeConfirm.toolName)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {cascadeConfirm && t("capabilities.disableToolConfirmDescription").replace("{skill}", cascadeConfirm.skillName)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleCascadeConfirm}>
              {t("capabilities.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
