// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { ArrowUpCircle, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ListDrawer } from "@/components/list-drawer";
import type { SkillState } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { SkillEnvPanel } from "./skill-env-panel";

/**
 * One skill of the agent, opened from its row: what it does, the controls that
 * belong to it (automatic loading, its environment variables, upgrading to the
 * newest version). Whether the agent has the skill is the row's switch, a draft
 * of the page's Save.
 */
export function AgentSkillSheet({
  slug,
  skill,
  enabled,
  upgrading,
  togglingAutoLoad,
  onAutoLoadChange,
  onUpgrade,
  onEnvSaved,
  onClose,
}: {
  slug: string;
  skill: SkillState | null;
  /** The switch as the page shows it, drafts included. */
  enabled: boolean;
  upgrading: boolean;
  togglingAutoLoad: boolean;
  onAutoLoadChange: (autoLoad: boolean) => void;
  onUpgrade: () => void;
  onEnvSaved: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const hasEnv = (skill?.requiredEnv?.length ?? 0) > 0;
  const envMissing = enabled && hasEnv && !skill?.envConfigured;
  const toolCount = skill?.requiredTools?.length ?? 0;

  return (
    <ListDrawer
      open={skill !== null}
      onOpenChange={(open) => !open && onClose()}
      title={skill?.name ?? ""}
      description={skill?.description || t("skills.tab.noDescription")}
      header={
        skill && (toolCount > 0 || skill.pinnedVersion || hasEnv || skill.hasUpdate) ? (
          <div className="flex flex-wrap gap-2 pt-1">
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
          </div>
        ) : undefined
      }
      actions={
        skill?.hasUpdate ? (
          <Button variant="outline" disabled={upgrading} onClick={onUpgrade}>
            <ArrowUpCircle className="size-4" aria-hidden />
            {upgrading ? t("common.saving") : t("skills.tab.upgrade")}
          </Button>
        ) : undefined
      }
    >
      {skill && (
        <>
          {enabled && (
            <section className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="skill-auto-load" className="flex items-center gap-1.5">
                  <Zap className={`size-3.5 ${skill.autoLoad ? "text-warning" : "text-muted-foreground/50"}`} aria-hidden />
                  {t("skills.tab.autoLoad")}
                </Label>
                <p className="text-sm text-muted-foreground">{t("skills.tab.autoLoadTooltip")}</p>
              </div>
              <Switch
                id="skill-auto-load"
                checked={skill.autoLoad ?? false}
                disabled={togglingAutoLoad}
                onCheckedChange={onAutoLoadChange}
              />
            </section>
          )}
          {enabled && hasEnv && <SkillEnvPanel slug={slug} skillName={skill.name} onSaved={onEnvSaved} />}
          {!enabled && <p className="text-sm text-muted-foreground">{t("skills.tab.disabledHint")}</p>}
        </>
      )}
    </ListDrawer>
  );
}
