// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, useMemo } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { ListEmpty } from "@/components/list-states";
import { SwitchList } from "@/components/switch-list";
import { api, getUserErrorMessage, type SkillState, type ToolState } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { AgentSkillSheet } from "./agent-skill-sheet";
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
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [togglingAutoLoad, setTogglingAutoLoad] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const skillEnabledMap = useMemo(() => new Map(skills.map((s) => [s.name, s.enabled])), [skills]);
  const toolEnabledMap = useMemo(() => new Map(tools.map((t) => [t.name, t.enabled])), [tools]);

  const getSkillEnabled = (name: string) => skillToggles[name] ?? skillEnabledMap.get(name) ?? false;

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

  const opened = openSkill ? skills.find((skill) => skill.name === openSkill) ?? null : null;

  if (skills.length === 0) {
    return <ListEmpty className="mt-8" title={t("skills.tab.empty")} />;
  }

  return (
    <div>
      {/* By name, and not enabled-first: a row that jumps to the top when its switch is flicked is hard to follow. */}
      <SwitchList
        rows={skills}
        rowKey={(skill) => skill.name}
        name={(skill) => skill.name}
        nameHeader={t("skills.table.name")}
        summary={(skill) => skill.description || undefined}
        searchText={(skill) => [skill.category]}
        badges={(skill) => {
          const isEnabled = getSkillEnabled(skill.name);
          const hasEnv = (skill.requiredEnv?.length ?? 0) > 0;
          const envMissing = isEnabled && hasEnv && !skill.envConfigured;
          const toolCount = skill.requiredTools?.length ?? 0;
          return (
            <>
              {toolCount > 0 && (
                <Badge variant="secondary">{t("capabilities.toolCount").replace("{count}", String(toolCount))}</Badge>
              )}
              {skill.pinnedVersion && (
                <Badge variant="secondary">{t("skills.tab.version").replace("{version}", skill.pinnedVersion)}</Badge>
              )}
              {hasEnv && (
                <Badge variant={envMissing ? "destructive" : "secondary"}>
                  {skill.requiredEnv!.length} env var{skill.requiredEnv!.length > 1 ? "s" : ""}
                </Badge>
              )}
              {skill.hasUpdate && <Badge variant="secondary">{t("skills.tab.updateAvailable")}</Badge>}
            </>
          );
        }}
        columns={[
          {
            header: t("skills.table.category"),
            className: "w-40",
            cell: (skill) =>
              skill.category ? <Badge variant="secondary">{skill.category}</Badge> : <span className="text-muted-foreground">—</span>,
          },
        ]}
        isOn={(skill) => getSkillEnabled(skill.name)}
        // The switch only stages the change: the page's Save writes it.
        onToggle={async (skill, checked) => handleSkillToggle(skill.name, checked)}
        switchLabel={(skill) => t("skills.tab.enabled", { name: skill.name })}
        onOpen={(skill) => setOpenSkill(skill.name)}
        selectedKey={openSkill}
      />

      <AgentSkillSheet
        slug={slug}
        skill={opened}
        enabled={opened ? getSkillEnabled(opened.name) : false}
        upgrading={upgrading === openSkill}
        togglingAutoLoad={togglingAutoLoad === openSkill}
        onAutoLoadChange={(checked) => opened && handleAutoLoadToggle(opened.name, checked)}
        onUpgrade={() => opened && handleUpgrade(opened.name)}
        onEnvSaved={refreshSkills}
        onClose={() => setOpenSkill(null)}
      />
    </div>
  );
}
