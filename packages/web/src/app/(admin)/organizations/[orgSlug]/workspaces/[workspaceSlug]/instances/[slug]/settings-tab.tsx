// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, getUserErrorMessage, type Instance } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";

interface Props {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
}

/**
 * An empty field means "no value here" and must reach the API as null, which is
 * what clears the column. A field the user is mid-way through typing (`"1."`,
 * `"-"`) is not a number yet: treated as empty rather than as NaN, which the
 * API would refuse with a 400 the user has not finished causing.
 */
function numberOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * The agent's behaviour parameters — what the engine puts in front of the
 * model each turn, and what it keeps afterwards. Rendered inside the Parametri
 * page, next to memory and diagnostics, and saved by the page's Save. The model
 * the agent runs is chosen in the Model section.
 */
export function SettingsTab({ instance, onUpdate }: Props) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);

  // Conversation state store: render known state read-only into the prompt (default off).
  const [stateInPromptEnabled, setStateInPromptEnabled] = useState(instance.stateInPromptEnabled);

  // Inject the current date/time into every turn (default on).
  const [datetimeInjectionEnabled, setDatetimeInjectionEnabled] = useState(instance.datetimeInjectionEnabled);

  /**
   * The six behaviours that used to be deployment configuration. Held as
   * STRINGS, empty for "declares none": an empty input has to stay empty rather
   * than showing the default as if the agent had chosen it, and the save maps
   * empty back to `null`, which is what clears the column.
   */
  const [overrides, setOverrides] = useState({
    datetimeTimezone: instance.datetimeTimezone ?? "",
    datetimeLocale: instance.datetimeLocale ?? "",
    dedupSimilarityThreshold: instance.dedupSimilarityThreshold?.toString() ?? "",
    messageSoftDebounceMs: instance.messageSoftDebounceMs?.toString() ?? "",
    messageTypingDelayMs: instance.messageTypingDelayMs?.toString() ?? "",
    messageMaxRestarts: instance.messageMaxRestarts?.toString() ?? "",
  });
  const setOverride = (key: keyof typeof overrides, value: string) =>
    setOverrides((prev) => ({ ...prev, [key]: value }));

  // Replay prior-turn tool results into the model's cross-turn history (default off).
  const [toolResultsInHistoryEnabled, setToolResultsInHistoryEnabled] = useState(
    instance.toolResultsInHistoryEnabled,
  );

  // DEBUG mode: persist the exact LLM request payload per turn (default off).
  const [debugEnabled, setDebugEnabled] = useState(instance.debugEnabled ?? false);

  // An override is dirty when its string differs from the stored value rendered
  // the same way — so clearing a field to empty counts, which is how a value is
  // handed back to the deployment default.
  const overridesDirty =
    overrides.datetimeTimezone !== (instance.datetimeTimezone ?? "") ||
    overrides.datetimeLocale !== (instance.datetimeLocale ?? "") ||
    overrides.dedupSimilarityThreshold !== (instance.dedupSimilarityThreshold?.toString() ?? "") ||
    overrides.messageSoftDebounceMs !== (instance.messageSoftDebounceMs?.toString() ?? "") ||
    overrides.messageTypingDelayMs !== (instance.messageTypingDelayMs?.toString() ?? "") ||
    overrides.messageMaxRestarts !== (instance.messageMaxRestarts?.toString() ?? "");

  const isDirty =
    stateInPromptEnabled !== instance.stateInPromptEnabled ||
    datetimeInjectionEnabled !== instance.datetimeInjectionEnabled ||
    overridesDirty ||
    toolResultsInHistoryEnabled !== instance.toolResultsInHistoryEnabled ||
    debugEnabled !== (instance.debugEnabled ?? false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { instance: updated } = await api.instances.update(instance.slug, {
        stateInPromptEnabled,
        datetimeInjectionEnabled,
        toolResultsInHistoryEnabled,
        debugEnabled,
        // Empty means "hand this back to the deployment default", which the API
        // spells as an explicit null — not as an omitted field, which would
        // leave the column as it is.
        datetimeTimezone: overrides.datetimeTimezone.trim() || null,
        datetimeLocale: overrides.datetimeLocale.trim() || null,
        dedupSimilarityThreshold: numberOrNull(overrides.dedupSimilarityThreshold),
        messageSoftDebounceMs: numberOrNull(overrides.messageSoftDebounceMs),
        messageTypingDelayMs: numberOrNull(overrides.messageTypingDelayMs),
        messageMaxRestarts: numberOrNull(overrides.messageMaxRestarts),
      });
      onUpdate(updated);
      toast.success(t("settings.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  const behaviourParamsBlock = (
        <section className="space-y-4 rounded-lg border p-4">
          <div>
            <Label className="text-base font-medium">{t("settings.tab.params")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.tab.paramsHelp")}</p>
          </div>

          {/*
            Conversation state store visibility. When on, the engine renders the
            per-conversation state (read-only) into the system prompt. Default off
            keeps the state purely tool-to-tool. Not model-gated.
          */}
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="agent-state-in-prompt" className="text-sm font-medium">
                {t("settings.tab.stateInPrompt")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.stateInPromptHelp")}
              </p>
            </div>
            <Switch
              id="agent-state-in-prompt"
              checked={stateInPromptEnabled}
              onCheckedChange={setStateInPromptEnabled}
            />
          </div>

          {/*
            Datetime injection. When on, the engine injects the current date/time
            into every turn as a <current_datetime> tag. Default on; off = a
            time-agnostic assistant.
          */}
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="agent-datetime-injection" className="text-sm font-medium">
                {t("settings.tab.datetimeInjection")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.datetimeInjectionHelp")}
              </p>
            </div>
            <Switch
              id="agent-datetime-injection"
              checked={datetimeInjectionEnabled}
              onCheckedChange={setDatetimeInjectionEnabled}
            />
          </div>

          {/*
            The six behaviours that used to be set for the whole installation.
            An empty field is not "zero": it means this agent declares nothing
            and the deployment default applies, which is why the placeholder
            shows that default rather than the input being pre-filled with it.
          */}
          <div className="space-y-4 border-t pt-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">{t("settings.tab.agentOverrides")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.agentOverridesHelp")}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-datetime-timezone" className="text-sm font-medium">
                {t("settings.tab.datetimeTimezone")}
              </Label>
              <Input
                id="agent-datetime-timezone"
                type="text"
                value={overrides.datetimeTimezone}
                placeholder="Europe/Rome"
                onChange={(e) => setOverride("datetimeTimezone", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.datetimeTimezoneHelp")}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-datetime-locale" className="text-sm font-medium">
                {t("settings.tab.datetimeLocale")}
              </Label>
              <Input
                id="agent-datetime-locale"
                type="text"
                value={overrides.datetimeLocale}
                placeholder="it-IT"
                onChange={(e) => setOverride("datetimeLocale", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.datetimeLocaleHelp")}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-dedup-threshold" className="text-sm font-medium">
                {t("settings.tab.dedupSimilarityThreshold")}
              </Label>
              <Input
                id="agent-dedup-threshold"
                type="number"
                value={overrides.dedupSimilarityThreshold}
                placeholder="0.90"
                onChange={(e) => setOverride("dedupSimilarityThreshold", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.dedupSimilarityThresholdHelp")}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-message-debounce" className="text-sm font-medium">
                {t("settings.tab.messageSoftDebounceMs")}
              </Label>
              <Input
                id="agent-message-debounce"
                type="number"
                value={overrides.messageSoftDebounceMs}
                placeholder="2000"
                onChange={(e) => setOverride("messageSoftDebounceMs", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.messageSoftDebounceMsHelp")}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-message-typing" className="text-sm font-medium">
                {t("settings.tab.messageTypingDelayMs")}
              </Label>
              <Input
                id="agent-message-typing"
                type="number"
                value={overrides.messageTypingDelayMs}
                placeholder="1500"
                onChange={(e) => setOverride("messageTypingDelayMs", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.messageTypingDelayMsHelp")}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-message-restarts" className="text-sm font-medium">
                {t("settings.tab.messageMaxRestarts")}
              </Label>
              <Input
                id="agent-message-restarts"
                type="number"
                value={overrides.messageMaxRestarts}
                placeholder="3"
                onChange={(e) => setOverride("messageMaxRestarts", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.messageMaxRestartsHelp")}
              </p>
            </div>
          </div>

          {/*
            Tool-result replay. When on, the engine reconstructs prior-turn
            tool_use/tool_result blocks (truncated) into the model's history so it
            retains what tools returned across turns. Default off (extra tokens).
          */}
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="agent-tool-results-history" className="text-sm font-medium">
                {t("settings.tab.toolResultsInHistory")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.toolResultsInHistoryHelp")}
              </p>
            </div>
            <Switch
              id="agent-tool-results-history"
              checked={toolResultsInHistoryEnabled}
              onCheckedChange={setToolResultsInHistoryEnabled}
            />
          </div>

          {/*
            DEBUG mode. When on, the engine persists the exact LLM request payload
            (full system prompt, the messages array sent, and the tool definitions)
            per turn, viewable from the playground / conversation message detail.
            Default off — heavy and stores PII at rest.
          */}
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="agent-debug" className="text-sm font-medium">
                {t("settings.tab.debug")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("settings.tab.debugHelp")}</p>
            </div>
            <Switch id="agent-debug" checked={debugEnabled} onCheckedChange={setDebugEnabled} />
          </div>
        </section>
  );

  return <div className="space-y-8">{behaviourParamsBlock}</div>;
}
