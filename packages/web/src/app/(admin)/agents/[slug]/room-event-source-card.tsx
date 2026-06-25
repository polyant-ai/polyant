// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Plus, Trash2, Copy, RotateCcw, ChevronDown, ChevronRight, Pencil, Check as CheckIcon, X as XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";

export interface EventSource {
  id: string;
  name: string;
  sourceType: string;
  enabled: boolean;
  webhookUrl: string;
  webhookToken: string;
  definitions: EventDefinition[];
}

export interface EventDefinition {
  id: string;
  name: string;
  matchingPrompt: string;
  interpretationPrompt: string;
  action: "backlog" | "conversation";
  contextPrompt: string | null;
  outboundChannel: string | null;
  outboundTarget: string | null;
  enabled: boolean;
}

const OUTBOUND_CHANNEL_NONE = "none";
const OUTBOUND_CHANNELS = [
  { value: "telegram", label: "Telegram" },
  { value: "slack", label: "Slack" },
  { value: "whatsapp", label: "WhatsApp" },
] as const;

interface DefinitionFormState {
  name: string;
  matchingPrompt: string;
  interpretationPrompt: string;
  action: "backlog" | "conversation";
  contextPrompt: string;
  outboundChannel: string;
  outboundTarget: string;
}

function DefinitionForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  t,
  className,
  children,
}: {
  value: DefinitionFormState;
  onChange: (next: DefinitionFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  t: (key: TranslationKey) => string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={className ?? "space-y-3"}>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">{t("room.definitions.name")}</Label>
          <Input className="h-8 text-sm" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("room.definitions.action")}</Label>
          <Select value={value.action} onValueChange={(v: "backlog" | "conversation") => onChange({ ...value, action: v })}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="backlog">{t("room.definitions.actionBacklog")}</SelectItem>
              <SelectItem value="conversation">{t("room.definitions.actionConversation")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("room.definitions.matchingPrompt")}</Label>
        <p className="text-xs text-muted-foreground mb-1">{t("room.definitions.matchingPromptHelp")}</p>
        <Textarea className="text-sm min-h-[60px]" placeholder={t("room.definitions.matchingPromptPlaceholder")} value={value.matchingPrompt} onChange={(e) => onChange({ ...value, matchingPrompt: e.target.value })} />
      </div>
      {value.action === "backlog" && (
        <div className="space-y-1">
          <Label className="text-xs">{t("room.definitions.interpretationPrompt")}</Label>
          <p className="text-xs text-muted-foreground mb-1">{t("room.definitions.interpretationPromptHelp")}</p>
          <Textarea className="text-sm min-h-[60px]" placeholder={t("room.definitions.interpretationPromptPlaceholder")} value={value.interpretationPrompt} onChange={(e) => onChange({ ...value, interpretationPrompt: e.target.value })} />
        </div>
      )}
      {value.action === "conversation" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs">{t("room.definitions.contextPrompt")}</Label>
            <p className="text-xs text-muted-foreground mb-1">{t("room.definitions.contextPromptHelp")}</p>
            <Textarea className="text-sm min-h-[80px]" placeholder={t("room.definitions.contextPromptPlaceholder")} value={value.contextPrompt} onChange={(e) => onChange({ ...value, contextPrompt: e.target.value })} />
          </div>
          <div className={value.outboundChannel && value.outboundChannel !== OUTBOUND_CHANNEL_NONE ? "grid grid-cols-2 gap-2" : ""}>
            <div className="space-y-1">
              <Label className="text-xs">{t("room.definitions.outboundChannel")}</Label>
              <Select
                value={value.outboundChannel || OUTBOUND_CHANNEL_NONE}
                onValueChange={(v) => onChange({
                  ...value,
                  outboundChannel: v === OUTBOUND_CHANNEL_NONE ? "" : v,
                  outboundTarget: v === OUTBOUND_CHANNEL_NONE ? "" : value.outboundTarget,
                })}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder={t("room.definitions.outboundChannelPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={OUTBOUND_CHANNEL_NONE}>{t("room.definitions.outboundChannelNone")}</SelectItem>
                  {OUTBOUND_CHANNELS.map((ch) => (
                    <SelectItem key={ch.value} value={ch.value}>{ch.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {value.outboundChannel && value.outboundChannel !== OUTBOUND_CHANNEL_NONE ? (
              <div className="space-y-1">
                <Label className="text-xs">{t("room.definitions.outboundTarget")}</Label>
                <Input className="h-8 text-sm" placeholder={t("room.definitions.outboundTargetPlaceholder")} value={value.outboundTarget} onChange={(e) => onChange({ ...value, outboundTarget: e.target.value })} />
              </div>
            ) : null}
          </div>
          {(!value.outboundChannel || value.outboundChannel === OUTBOUND_CHANNEL_NONE) && (
            <p className="text-xs text-muted-foreground">{t("room.definitions.outboundChannelNoneHelp")}</p>
          )}
        </>
      )}
      {children}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button size="sm" onClick={onSubmit}>{submitLabel}</Button>
      </div>
    </div>
  );
}

interface Props {
  source: EventSource;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onCopyWebhook: (url: string) => void;
  onRotateToken: (id: string) => void;
  onUpdateSource: (id: string, data: { name?: string }) => void;
  onDeleteSource: (id: string) => void;
  onAddDefinition: (sourceId: string, data: {
    name: string; matchingPrompt: string; interpretationPrompt: string;
    action?: string; contextPrompt?: string; outboundChannel?: string; outboundTarget?: string;
  }) => void;
  onUpdateDefinition: (sourceId: string, defId: string, data: {
    name: string; matchingPrompt: string; interpretationPrompt: string; enabled: boolean;
    action?: string; contextPrompt?: string | null; outboundChannel?: string | null; outboundTarget?: string | null;
  }) => void;
  onDeleteDefinition: (sourceId: string, defId: string) => void;
}

export function EventSourceCard({
  source, expanded, onToggleExpand, onToggleEnabled, onCopyWebhook, onRotateToken,
  onUpdateSource, onDeleteSource, onAddDefinition, onUpdateDefinition, onDeleteDefinition,
}: Props) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState<string | null>(null);
  const [showNewDef, setShowNewDef] = useState(false);
  const [newDef, setNewDef] = useState({
    name: "", matchingPrompt: "", interpretationPrompt: "",
    action: "backlog" as "backlog" | "conversation",
    contextPrompt: "", outboundChannel: "", outboundTarget: "",
  });
  const [editingDef, setEditingDef] = useState<{
    defId: string; name: string; matchingPrompt: string; interpretationPrompt: string; enabled: boolean;
    action: "backlog" | "conversation";
    contextPrompt: string; outboundChannel: string; outboundTarget: string;
  } | null>(null);

  function handleSubmitNewDef() {
    const isConversation = newDef.action === "conversation";
    const channelSet = isConversation && !!newDef.outboundChannel;
    onAddDefinition(source.id, {
      ...newDef,
      contextPrompt: isConversation ? newDef.contextPrompt : undefined,
      outboundChannel: channelSet ? newDef.outboundChannel : undefined,
      outboundTarget: channelSet ? newDef.outboundTarget : undefined,
    });
    setNewDef({ name: "", matchingPrompt: "", interpretationPrompt: "", action: "backlog", contextPrompt: "", outboundChannel: "", outboundTarget: "" });
    setShowNewDef(false);
  }

  function handleSubmitEditDef() {
    if (!editingDef) return;
    const isConversation = editingDef.action === "conversation";
    const channelSet = isConversation && !!editingDef.outboundChannel;
    onUpdateDefinition(source.id, editingDef.defId, {
      name: editingDef.name,
      matchingPrompt: editingDef.matchingPrompt,
      interpretationPrompt: editingDef.interpretationPrompt,
      enabled: editingDef.enabled,
      action: editingDef.action,
      contextPrompt: isConversation ? editingDef.contextPrompt : null,
      outboundChannel: channelSet ? editingDef.outboundChannel : null,
      outboundTarget: channelSet ? editingDef.outboundTarget : null,
    });
    setEditingDef(null);
  }

  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1" onClick={onToggleExpand}>
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {editingName !== null ? (
            <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); onUpdateSource(source.id, { name: editingName }); setEditingName(null); }}>
              <Input className="h-7 w-48 text-sm font-medium" value={editingName} onChange={(e) => setEditingName(e.target.value)} autoFocus />
              <Button type="submit" size="icon" variant="ghost" className="h-7 w-7" disabled={!editingName.trim()}>
                <CheckIcon className="h-3 w-3" />
              </Button>
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingName(null)}>
                <XIcon className="h-3 w-3" />
              </Button>
            </form>
          ) : (
            <button className="flex items-center gap-2 text-left" onClick={onToggleExpand}>
              <span className="font-medium">{source.name}</span>
            </button>
          )}
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingName(source.name)}>
            <Pencil className="h-3 w-3" />
          </Button>
          <Badge variant="secondary">{source.sourceType}</Badge>
          <Badge variant={source.enabled ? "default" : "secondary"}>{source.enabled ? t("common.enabled") : t("common.disabled")}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={source.enabled}
            onCheckedChange={(v) => onToggleEnabled(source.id, v)}
          />
          <Button size="icon" variant="ghost" onClick={() => onCopyWebhook(source.webhookUrl)}>
            <Copy className="h-4 w-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="icon" variant="ghost" className="text-muted-foreground">
                <RotateCcw className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("room.sources.rotateToken")}</AlertDialogTitle>
                <AlertDialogDescription>{t("room.sources.rotateConfirm")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => onRotateToken(source.id)}>{t("common.save")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="icon" variant="ghost" className="text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("room.source.deleteConfirm")}</AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => onDeleteSource(source.id)}>{t("common.delete")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-4">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t("room.sources.webhookUrl")}</Label>
            <code className="block text-xs bg-muted rounded px-2 py-1 break-all">{source.webhookUrl}</code>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{t("room.definitions.title")}</h3>
              <Button size="sm" variant="outline" onClick={() => setShowNewDef(true)}>
                <Plus className="h-3 w-3 mr-1" />
                {t("room.definitions.add")}
              </Button>
            </div>

            {showNewDef && (
              <div className="rounded border p-3 bg-muted/30">
                <DefinitionForm
                  value={newDef}
                  onChange={setNewDef}
                  onSubmit={handleSubmitNewDef}
                  onCancel={() => setShowNewDef(false)}
                  submitLabel={t("common.save")}
                  t={t}
                  className="space-y-2"
                />
              </div>
            )}

            {source.definitions.map((def) => (
              <div key={def.id} className="rounded border">
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{def.name}</span>
                    <Badge variant={def.action === "conversation" ? "outline" : "secondary"} className="text-xs">
                      {def.action === "conversation" ? t("room.definitions.actionConversation") : t("room.definitions.actionBacklog")}
                    </Badge>
                    <Badge variant={def.enabled ? "default" : "secondary"} className="text-xs">{def.enabled ? t("common.enabled") : t("common.disabled")}</Badge>
                  </div>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingDef({
                      defId: def.id, name: def.name,
                      matchingPrompt: def.matchingPrompt, interpretationPrompt: def.interpretationPrompt, enabled: def.enabled,
                      action: (def.action ?? "backlog") as "backlog" | "conversation",
                      contextPrompt: def.contextPrompt ?? "",
                      outboundChannel: def.outboundChannel ?? "",
                      outboundTarget: def.outboundTarget ?? "",
                    })}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="icon" variant="ghost" className="text-destructive h-7 w-7">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("room.definition.deleteConfirm")}</AlertDialogTitle>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                          <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => onDeleteDefinition(source.id, def.id)}>{t("common.delete")}</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
                {editingDef?.defId === def.id && (
                  <div className="border-t px-3 py-3">
                    <DefinitionForm
                      value={editingDef}
                      onChange={(next) => setEditingDef({ ...editingDef, ...next })}
                      onSubmit={handleSubmitEditDef}
                      onCancel={() => setEditingDef(null)}
                      submitLabel={t("common.save")}
                      t={t}
                      className="space-y-3"
                    >
                      <div className="flex items-center gap-2">
                        <Switch checked={editingDef.enabled} onCheckedChange={(v) => setEditingDef({ ...editingDef, enabled: v })} />
                        <Label className="text-xs">{t("common.enabled")}</Label>
                      </div>
                    </DefinitionForm>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
