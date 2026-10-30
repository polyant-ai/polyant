// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, getUserErrorMessage, type Instance, type IntermediateTextPolicy } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";
import { useDraft } from "./use-draft";

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

/** The select's value for "no policy chosen": a select item cannot carry an empty value. */
const UNSET = "unset";
const INTERMEDIATE_TEXT_OPTIONS: readonly IntermediateTextPolicy[] = ["discard", "progress", "reply"];

function intermediateTextOrNull(value: string): IntermediateTextPolicy | null {
  return INTERMEDIATE_TEXT_OPTIONS.find((option) => option === value) ?? null;
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

  /**
   * The six numeric/text overrides are held as STRINGS, empty for "declares
   * none": an empty input has to stay empty rather than showing the default as
   * if the agent had chosen it, and the save maps empty back to `null`, which is
   * what clears the column. A field is dirty when its string differs from the
   * stored value rendered the same way, so clearing one counts — that is how a
   * value is handed back to the deployment default.
   */
  const { draft, set, isDirty } = useDraft({
    // Conversation state store: render known state read-only into the prompt (default off).
    stateInPromptEnabled: instance.stateInPromptEnabled,
    // Inject the current date/time into every turn (default on).
    datetimeInjectionEnabled: instance.datetimeInjectionEnabled,
    datetimeTimezone: instance.datetimeTimezone ?? "",
    datetimeLocale: instance.datetimeLocale ?? "",
    dedupSimilarityThreshold: instance.dedupSimilarityThreshold?.toString() ?? "",
    messageSoftDebounceMs: instance.messageSoftDebounceMs?.toString() ?? "",
    messageTypingDelayMs: instance.messageTypingDelayMs?.toString() ?? "",
    messageMaxRestarts: instance.messageMaxRestarts?.toString() ?? "",
    // Replay prior-turn tool results into the model's cross-turn history (default off).
    toolResultsInHistoryEnabled: instance.toolResultsInHistoryEnabled,
    // What becomes of text written alongside a tool call (unset = per-channel behaviour).
    intermediateText: instance.intermediateText ?? UNSET,
    // DEBUG mode: persist the exact LLM request payload per turn (default off).
    debugEnabled: instance.debugEnabled ?? false,
  });
  const { stateInPromptEnabled, datetimeInjectionEnabled, toolResultsInHistoryEnabled, debugEnabled } = draft;

  const handleSave = async () => {
    setSaving(true);
    try {
      const { instance: updated } = await api.instances.update(instance.slug, {
        stateInPromptEnabled,
        datetimeInjectionEnabled,
        toolResultsInHistoryEnabled,
        debugEnabled,
        intermediateText: intermediateTextOrNull(draft.intermediateText),
        // Empty means "hand this back to the deployment default", which the API
        // spells as an explicit null — not as an omitted field, which would
        // leave the column as it is.
        datetimeTimezone: draft.datetimeTimezone.trim() || null,
        datetimeLocale: draft.datetimeLocale.trim() || null,
        dedupSimilarityThreshold: numberOrNull(draft.dedupSimilarityThreshold),
        messageSoftDebounceMs: numberOrNull(draft.messageSoftDebounceMs),
        messageTypingDelayMs: numberOrNull(draft.messageTypingDelayMs),
        messageMaxRestarts: numberOrNull(draft.messageMaxRestarts),
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
              onCheckedChange={(v) => set("stateInPromptEnabled", v)}
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
              onCheckedChange={(v) => set("datetimeInjectionEnabled", v)}
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
                value={draft.datetimeTimezone}
                placeholder="Europe/Rome"
                onChange={(e) => set("datetimeTimezone", e.target.value)}
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
                value={draft.datetimeLocale}
                placeholder="it-IT"
                onChange={(e) => set("datetimeLocale", e.target.value)}
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
                value={draft.dedupSimilarityThreshold}
                placeholder="0.90"
                onChange={(e) => set("dedupSimilarityThreshold", e.target.value)}
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
                value={draft.messageSoftDebounceMs}
                placeholder="2000"
                onChange={(e) => set("messageSoftDebounceMs", e.target.value)}
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
                value={draft.messageTypingDelayMs}
                placeholder="1500"
                onChange={(e) => set("messageTypingDelayMs", e.target.value)}
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
                value={draft.messageMaxRestarts}
                placeholder="3"
                onChange={(e) => set("messageMaxRestarts", e.target.value)}
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
              onCheckedChange={(v) => set("toolResultsInHistoryEnabled", v)}
            />
          </div>

          {/*
            Text the model writes alongside a tool call. Unset leaves each
            channel as it was (a stream shows it, a buffered channel drops it);
            a chosen policy applies everywhere and the engine states it to the
            model in the system prompt.
          */}
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="agent-intermediate-text" className="text-sm font-medium">
                {t("settings.tab.intermediateText")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("settings.tab.intermediateTextHelp")}</p>
            </div>
            <Select value={draft.intermediateText} onValueChange={(value) => set("intermediateText", value)}>
              <SelectTrigger id="agent-intermediate-text" className="w-56 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>{t("settings.tab.intermediateTextUnset")}</SelectItem>
                <SelectItem value="discard">{t("settings.tab.intermediateTextDiscard")}</SelectItem>
                <SelectItem value="progress">{t("settings.tab.intermediateTextProgress")}</SelectItem>
                <SelectItem value="reply">{t("settings.tab.intermediateTextReply")}</SelectItem>
              </SelectContent>
            </Select>
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
            <Switch id="agent-debug" checked={debugEnabled} onCheckedChange={(v) => set("debugEnabled", v)} />
          </div>
        </section>
  );

  return <div className="space-y-8">{behaviourParamsBlock}</div>;
}
