// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, getUserErrorMessage, type Instance } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";

/**
 * Whether the agent remembers, and the warning when it cannot.
 *
 * Its third home, and the reason it kept moving is that it was always beside
 * something it is not: first the model picker (memory is not a property of which
 * model runs), then the agent's name and icon, then the knowledge documents —
 * where it read as an afterthought under a list it has nothing to do with.
 *
 * It belongs with the per-turn parameters: everything on that page is about what
 * the engine carries into a turn and what it keeps after, which is exactly what
 * memory is.
 */
export function MemoryCard({
  instance,
  onUpdate,
}: {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(instance.memoryEnabled);

  // Re-sync when the parent reloads the agent: local state would otherwise keep
  // showing the pre-save value.
  useEffect(() => {
    setEnabled(instance.memoryEnabled);
  }, [instance.memoryEnabled]);

  const isDirty = enabled !== instance.memoryEnabled;

  const handleSave = async () => {
    setSaving(true);
    try {
      const { instance: updated } = await api.instances.update(instance.slug, {
        memoryEnabled: enabled,
      });
      onUpdate(updated);
      toast.success(t("general.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("general.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="agent-memory" className="text-base font-medium">
            {t("settings.tab.memory")}
          </Label>
          <p className="text-sm text-muted-foreground">{t("settings.tab.memoryHelp")}</p>
        </div>
        <Switch
          id="agent-memory"
          checked={enabled}
          disabled={saving}
          onCheckedChange={setEnabled}
        />
      </div>

      {/* Memory embeds every extracted fact, so it needs embedder credentials. The
          engine reports the state on the instance; a client-side copy of the rule
          would not see the AWS_REGION fallback. */}
      {enabled && instance.memory?.needsOpenAIKey && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-900 dark:text-amber-200">
            {t(
              (instance.embeddingProvider as string | undefined) === "bedrock"
                ? "memory.banner.bedrockNeedsAws"
                : "memory.banner.openaiNeedsKey",
            )}
          </p>
        </div>
      )}
    </section>
  );
}
