// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, useMemo } from "react";
import { toast } from "sonner";
import { Puzzle, Settings2, ArrowUpCircle, Zap } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, getUserErrorMessage, type SkillState, type ToolState } from "@/lib/api";
import { SkillEnvDialog } from "./skill-env-dialog";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  slug: string;
  skills: SkillState[];
  tools: ToolState[];
  onSkillsUpdate: (skills: SkillState[]) => void;
  onToolsUpdate: (tools: ToolState[]) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SkillsTab({ slug, skills, tools, onSkillsUpdate, onToolsUpdate }: Props) {
  const { t } = useI18n();

  const [skillToggles, setSkillToggles] = useState<Record<string, boolean>>({});
  const [toolToggles, setToolToggles] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [envDialogSkill, setEnvDialogSkill] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [togglingAutoLoad, setTogglingAutoLoad] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const skillEnabledMap = useMemo(() => new Map(skills.map((s) => [s.name, s.enabled])), [skills]);
  const toolEnabledMap = useMemo(() => new Map(tools.map((t) => [t.name, t.enabled])), [tools]);

  const getSkillEnabled = (name: string) => skillToggles[name] ?? skillEnabledMap.get(name) ?? false;
  const getToolEnabled = (name: string) => toolToggles[name] ?? toolEnabledMap.get(name) ?? false;

  const isDirty = useMemo(() => {
    const skillDirty = Object.keys(skillToggles).some((name) =>
      skillToggles[name] !== skillEnabledMap.get(name),
    );
    const toolDirty = Object.keys(toolToggles).some((name) =>
      toolToggles[name] !== toolEnabledMap.get(name),
    );
    return skillDirty || toolDirty;
  }, [skillToggles, toolToggles, skillEnabledMap, toolEnabledMap]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSkillToggle = (name: string, enabled: boolean) => {
    setSkillToggles((prev) => ({ ...prev, [name]: enabled }));

    // Cascade: enabling a skill auto-enables its required tools.
    // Use functional updater to read latest toolToggles state (avoids stale closure).
    if (enabled) {
      const skill = skills.find((s) => s.name === name);
      if (skill?.requiredTools) {
        setToolToggles((prev) => {
          const updates: Record<string, boolean> = {};
          for (const toolName of skill.requiredTools!) {
            const currentEnabled = prev[toolName] ?? toolEnabledMap.get(toolName) ?? false;
            if (!currentEnabled) {
              updates[toolName] = true;
            }
          }
          return Object.keys(updates).length > 0 ? { ...prev, ...updates } : prev;
        });
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Save skills
      const enabledSkills = skills
        .map((s) => ({ name: s.name, enabled: skillToggles[s.name] ?? s.enabled }))
        .filter((s) => s.enabled)
        .map((s) => s.name);
      const result = await api.skills.update(slug, enabledSkills);
      onSkillsUpdate(result.skills);

      // Save tools if cascade changed any
      const toolDirty = Object.keys(toolToggles).some((name) => {
        const original = tools.find((t) => t.name === name);
        return original && toolToggles[name] !== original.enabled;
      });

      if (toolDirty) {
        const enabledTools = tools
          .map((t) => ({ name: t.name, enabled: toolToggles[t.name] ?? t.enabled }))
          .filter((t) => t.enabled)
          .map((t) => t.name);
        const { tools: updatedTools } = await api.tools.update(slug, enabledTools);
        onToolsUpdate(updatedTools);
      }

      setSkillToggles({});
      setToolToggles({});
      toast.success(t("skills.tab.saved"));

      if (result.toolsChanged) {
        if (result.toolsChanged.added.length > 0) {
          toast.info(t("skills.tab.toolsAdded").replace("{tools}", result.toolsChanged.added.join(", ")));
        }
        if (result.toolsChanged.removed.length > 0) {
          toast.info(t("skills.tab.toolsRemoved").replace("{tools}", result.toolsChanged.removed.join(", ")));
        }
      }
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("skills.tab.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  const handleAutoLoadToggle = async (skillName: string, autoLoad: boolean) => {
    setTogglingAutoLoad(skillName);
    try {
      await api.skills.setAutoLoad(slug, skillName, autoLoad);
      onSkillsUpdate(skills.map((s) => (s.name === skillName ? { ...s, autoLoad } : s)));
      toast.success(t(autoLoad ? "skills.tab.autoLoadEnabled" : "skills.tab.autoLoadDisabled"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("skills.tab.saveFailed")));
    } finally {
      setTogglingAutoLoad(null);
    }
  };

  const handleUpgrade = async (skillName: string) => {
    setUpgrading(skillName);
    try {
      await api.skills.upgrade(slug, skillName);
      const { skills: updated } = await api.skills.list(slug);
      onSkillsUpdate(updated);
      toast.success(t("skills.tab.upgraded"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("skills.tab.upgradeFailed")));
    } finally {
      setUpgrading(null);
    }
  };

  const refreshSkills = async () => {
    try {
      const { skills: updated } = await api.skills.list(slug);
      onSkillsUpdate(updated);
    } catch {
      // silent
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Group: enabled first, then disabled — both alphabetically (backend already sorts by name)
  const sortedSkills = useMemo(() => {
    const enabled = skills.filter((s) => getSkillEnabled(s.name));
    const disabled = skills.filter((s) => !getSkillEnabled(s.name));
    return [...enabled, ...disabled];
  }, [skills, skillToggles, skillEnabledMap]);

  const renderSkillCard = (skill: SkillState) => {
    const isEnabled = getSkillEnabled(skill.name);
    const hasEnv = (skill.requiredEnv?.length ?? 0) > 0;
    const envMissing = isEnabled && hasEnv && !skill.envConfigured;
    const toolCount = skill.requiredTools?.length ?? 0;

    return (
      <div
        key={skill.name}
        className={`rounded-lg border p-4 transition-colors ${
          isEnabled ? "bg-background border-primary/20" : "bg-muted/30 opacity-60"
        }`}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Puzzle className="size-4 shrink-0 text-primary" />
              <span className="font-medium text-sm">{skill.name}</span>
              {toolCount > 0 && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {t("capabilities.toolCount").replace("{count}", String(toolCount))}
                </Badge>
              )}
              {skill.pinnedVersion && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {t("skills.tab.version").replace("{version}", skill.pinnedVersion)}
                </Badge>
              )}
              {hasEnv && (
                <Badge
                  variant={envMissing ? "destructive" : "secondary"}
                  className="text-[10px] px-1.5 py-0"
                >
                  {skill.requiredEnv!.length} env var{skill.requiredEnv!.length > 1 ? "s" : ""}
                </Badge>
              )}
              {skill.hasUpdate && (
                <Badge
                  variant="outline"
                  className="border-amber-300 text-amber-600 dark:border-amber-700 dark:text-amber-400 text-[10px] px-1.5 py-0"
                >
                  {t("skills.tab.updateAvailable")}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{skill.description}</p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isEnabled && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5">
                      <Zap className={`size-3.5 ${skill.autoLoad ? "text-amber-500" : "text-muted-foreground/50"}`} />
                      <Switch
                        size="sm"
                        checked={skill.autoLoad ?? false}
                        disabled={togglingAutoLoad === skill.name}
                        onCheckedChange={(checked) => handleAutoLoadToggle(skill.name, checked)}
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p>{t("skills.tab.autoLoadTooltip")}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {skill.hasUpdate && (
              <Button variant="outline" size="sm" disabled={upgrading === skill.name} onClick={() => handleUpgrade(skill.name)}>
                <ArrowUpCircle className="mr-1.5 size-4" />
                {upgrading === skill.name ? t("common.saving") : t("skills.tab.upgrade")}
              </Button>
            )}
            {isEnabled && hasEnv && (
              <Button variant="ghost" size="sm" onClick={() => setEnvDialogSkill(skill.name)}>
                <Settings2 className="mr-1.5 size-4" />
                {t("skills.tab.configure")}
              </Button>
            )}
            <Switch
              checked={isEnabled}
              onCheckedChange={(checked) => handleSkillToggle(skill.name, checked)}
            />
          </div>
        </div>
      </div>
    );
  };

  if (skills.length === 0) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-muted-foreground">{t("skills.tab.empty")}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <p className="mb-6 text-sm text-muted-foreground">
        {t("skills.tab.description")}
      </p>

      <div className="space-y-2">
        {sortedSkills.map(renderSkillCard)}
      </div>

      {envDialogSkill && (
        <SkillEnvDialog
          open
          onOpenChange={(open) => !open && setEnvDialogSkill(null)}
          slug={slug}
          skillName={envDialogSkill}
          onSaved={refreshSkills}
        />
      )}
    </div>
  );
}
