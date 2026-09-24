// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, ChevronRight, MinusCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { getUserErrorMessage } from "@/lib/api";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { ToolState } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { SecretSpecField, humanizeSecretKey } from "@/components/instance-secret/secret-spec-field";
import type { SecretSpecsForm } from "@/components/instance-secret/use-secret-specs";
import {
  categoryLabel,
  descriptionSummary,
  pluginNamespaceOf,
  toolDisplayName,
  toolParamSpecs,
  toolProviderSpecs,
} from "./tools-tab-helpers";

interface Props {
  tool: ToolState | null;
  tools: readonly ToolState[];
  isEnabled: (name: string) => boolean;
  /** Enabled in the page's draft but not saved yet. */
  pendingEnable: boolean;
  /** A reason the tool does nothing even while enabled (a layer switched off), or null. */
  lockReason: string | null;
  /** How a plugin is named in this panel: its manifest's display name, or its namespace. */
  pluginName: (namespace: string) => string;
  params: SecretSpecsForm;
  /** After the panel wrote parameter values, so the status checks re-read them. */
  onParamsSaved?: () => void;
  onEnable: (name: string) => void;
  onDisable: (name: string) => void;
  onClose: () => void;
}

/**
 * One tool, opened from its row: what it does, the parameters it declares, and —
 * for a plugin tool — its siblings, each with its own switch. The plugin is how
 * the tools are grouped, never what is switched: every tool is enabled on its own.
 *
 * The switches change the page's draft, confirmed by the page's Save. The
 * parameters are saved here, with their own button: they are the agent's keys,
 * not part of the switch, so writing one before the tool is saved is harmless —
 * the tool reads it once it is enabled. Closing with unsaved values asks first.
 */
export function ToolSheet({
  tool,
  tools,
  isEnabled,
  pendingEnable,
  lockReason,
  pluginName,
  params,
  onParamsSaved,
  onEnable,
  onDisable,
  onClose,
}: Props) {
  const { t } = useI18n();
  const [savingParams, setSavingParams] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const saveParams = async () => {
    setSavingParams(true);
    try {
      await params.save();
      toast.success(t("tools.paramsSaved"));
      onParamsSaved?.();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("tools.saveFailed")));
    } finally {
      setSavingParams(false);
    }
  };

  const requestClose = () => {
    if (params.dirty) setConfirmDiscard(true);
    else onClose();
  };
  const namespace = tool ? pluginNamespaceOf(tool.name) : null;
  const siblings = tool && namespace
    ? tools.filter((other) => other.name !== tool.name && pluginNamespaceOf(other.name) === namespace && other.source !== "global")
    : [];
  const specs = tool ? toolParamSpecs(tool) : [];
  const providerSpecs = tool ? toolProviderSpecs(tool) : [];
  const alwaysEnabled = tool?.source === "global";

  // Which enabled tools ask for the same key: a plugin's key is usually shared.
  const askers = (key: string) =>
    tools
      .filter((other) => isEnabled(other.name) && (other.requiredSecrets ?? []).some((s) => s.key === key))
      .map((other) => toolDisplayName(other.name));

  return (
    <>
    <Sheet open={tool !== null} onOpenChange={(open) => !open && requestClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        {tool && (
          <>
            <SheetHeader className="gap-2 border-b p-5 pr-12">
              <SheetTitle className="font-mono text-base font-medium">{toolDisplayName(tool.name)}</SheetTitle>
              <SheetDescription>{descriptionSummary(tool.description)}</SheetDescription>
              {/* The rest of a description is written for the model — usage rules,
                  limits — and would bury the parameters below; it is one click away. */}
              {tool.description.trim() !== descriptionSummary(tool.description) && (
                <Collapsible>
                  <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
                    {t("tools.detailsToggle")}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className="mt-2 whitespace-pre-line text-xs text-muted-foreground">{tool.description.trim()}</p>
                  </CollapsibleContent>
                </Collapsible>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge variant="secondary">{namespace ? pluginName(namespace) : t("tools.originCore")}</Badge>
                <Badge variant="secondary">{categoryLabel(tool.category)}</Badge>
              </div>
            </SheetHeader>

            <div className="flex-1 space-y-8 overflow-y-auto p-5">
              {lockReason && (
                <div className="flex gap-2 rounded-md bg-warning/10 p-3 text-sm text-warning">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <p>{lockReason}</p>
                </div>
              )}

              <section className="space-y-4">
                <h3 className="text-sm font-medium">{t("tools.params")}</h3>
                {specs.length === 0 && providerSpecs.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t("tools.paramsNone")}</p>
                )}
                {specs.length > 0 && !params.canRead && (
                  <p className="text-sm text-muted-foreground">{t("tools.paramsNoAccess")}</p>
                )}
                {specs.map((spec) =>
                  params.canRead ? (
                    <div key={spec.key} className="space-y-1.5">
                      <SecretSpecField spec={spec} form={params} />
                      <p className="text-xs text-muted-foreground">
                        {t("tools.paramAskedBy", { names: askers(spec.key).join(", ") })}
                      </p>
                    </div>
                  ) : (
                    <div key={spec.key} className="space-y-1">
                      <p className="text-sm font-medium">{spec.label ?? humanizeSecretKey(spec.key)}</p>
                      <p className="text-xs text-muted-foreground">{spec.description ?? t("tools.paramNoDescription")}</p>
                    </div>
                  ),
                )}
                {specs.length > 0 && params.canRead && (
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <p className="text-xs text-muted-foreground">
                      {pendingEnable ? t("tools.paramsBeforeTool") : ""}
                    </p>
                    <Button size="sm" onClick={saveParams} disabled={!params.dirty || savingParams}>
                      {t("tools.paramsSave")}
                    </Button>
                  </div>
                )}
                {providerSpecs.map((spec) => (
                  <div key={spec.key} className="space-y-1">
                    <p className="text-sm font-medium">{spec.label ?? humanizeSecretKey(spec.key)}</p>
                    <Link href="?tab=credentials" className="text-xs underline underline-offset-4">
                      {t("tools.paramProviderCredential")}
                    </Link>
                  </div>
                ))}
              </section>

              {siblings.length > 0 && namespace && (
                <section className="space-y-3">
                  <h3 className="flex items-baseline justify-between gap-2 text-sm font-medium">
                    {t("tools.siblings", { plugin: pluginName(namespace) })}
                    <span className="text-xs font-normal text-muted-foreground">{t("tools.siblingsHint")}</span>
                  </h3>
                  <ul className="divide-y rounded-md border">
                    {siblings.map((sibling) => {
                      const on = isEnabled(sibling.name);
                      const id = `sibling-${sibling.name}`;
                      return (
                        <li key={sibling.name} className="flex items-center gap-3 px-3 py-1.5">
                          <Switch
                            id={id}
                            checked={on}
                            onCheckedChange={(checked) => (checked ? onEnable(sibling.name) : onDisable(sibling.name))}
                          />
                          <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                            <span className="block truncate text-sm" title={descriptionSummary(sibling.description)}>
                              <span className="font-mono">{toolDisplayName(sibling.name)}</span>
                              <span className="text-xs text-muted-foreground"> · {descriptionSummary(sibling.description)}</span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </div>

            <SheetFooter className="flex-row justify-between border-t p-4">
              {alwaysEnabled ? (
                <span className="text-sm text-muted-foreground">{t("tools.cannotDisable")}</span>
              ) : (
                <Button variant="ghost" onClick={() => onDisable(tool.name)}>
                  <MinusCircle className="size-4" aria-hidden />
                  {t("tools.disable")}
                </Button>
              )}
              <Button variant="outline" onClick={requestClose}>
                {t("common.close")}
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>

    <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("tools.discardTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("tools.discardBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("tools.keepEditing")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              params.reset();
              setConfirmDiscard(false);
              onClose();
            }}
          >
            {t("tools.discardConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
