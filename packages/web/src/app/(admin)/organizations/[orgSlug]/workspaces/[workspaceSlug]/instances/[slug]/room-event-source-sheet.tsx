// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Plus, Copy, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DrawerDeleteButton, ListDrawer } from "@/components/list-drawer";
import { SwitchList } from "@/components/switch-list";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import { WebhookAuthSection } from "./room-event-source-auth";

/**
 * The list response (ROOM_READ) deliberately omits `webhookUrl`/`webhookToken`
 * — the token is bearer-equivalent. The drawer receives the revealed URL (if
 * any) as a separate prop, fetched on demand by the parent.
 */
export interface EventSource {
  id: string;
  name: string;
  sourceType: string;
  enabled: boolean;
  /** Non-secret config; string values are masked (••••last4) by the API. */
  config?: Record<string, unknown>;
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

const EMPTY_DEFINITION: DefinitionFormState = {
  name: "", matchingPrompt: "", interpretationPrompt: "",
  action: "backlog", contextPrompt: "", outboundChannel: "", outboundTarget: "",
};

function formOf(def: EventDefinition): DefinitionFormState {
  return {
    name: def.name,
    matchingPrompt: def.matchingPrompt,
    interpretationPrompt: def.interpretationPrompt,
    action: def.action ?? "backlog",
    contextPrompt: def.contextPrompt ?? "",
    outboundChannel: def.outboundChannel ?? "",
    outboundTarget: def.outboundTarget ?? "",
  };
}

function DefinitionFields({
  value,
  onChange,
}: {
  value: DefinitionFormState;
  onChange: (next: DefinitionFormState) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>{t("room.definitions.name")}</Label>
          <Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>{t("room.definitions.action")}</Label>
          <Select value={value.action} onValueChange={(v: "backlog" | "conversation") => onChange({ ...value, action: v })}>
            <SelectTrigger>
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
        <Label>{t("room.definitions.matchingPrompt")}</Label>
        <p className="mb-1 text-xs text-muted-foreground">{t("room.definitions.matchingPromptHelp")}</p>
        <Textarea className="min-h-[60px]" placeholder={t("room.definitions.matchingPromptPlaceholder")} value={value.matchingPrompt} onChange={(e) => onChange({ ...value, matchingPrompt: e.target.value })} />
      </div>
      {value.action === "backlog" && (
        <div className="space-y-1">
          <Label>{t("room.definitions.interpretationPrompt")}</Label>
          <p className="mb-1 text-xs text-muted-foreground">{t("room.definitions.interpretationPromptHelp")}</p>
          <Textarea className="min-h-[60px]" placeholder={t("room.definitions.interpretationPromptPlaceholder")} value={value.interpretationPrompt} onChange={(e) => onChange({ ...value, interpretationPrompt: e.target.value })} />
        </div>
      )}
      {value.action === "conversation" && (
        <>
          <div className="space-y-1">
            <Label>{t("room.definitions.contextPrompt")}</Label>
            <p className="mb-1 text-xs text-muted-foreground">{t("room.definitions.contextPromptHelp")}</p>
            <Textarea className="min-h-[80px]" placeholder={t("room.definitions.contextPromptPlaceholder")} value={value.contextPrompt} onChange={(e) => onChange({ ...value, contextPrompt: e.target.value })} />
          </div>
          <div className={value.outboundChannel && value.outboundChannel !== OUTBOUND_CHANNEL_NONE ? "grid grid-cols-2 gap-3" : ""}>
            <div className="space-y-1">
              <Label>{t("room.definitions.outboundChannel")}</Label>
              <Select
                value={value.outboundChannel || OUTBOUND_CHANNEL_NONE}
                onValueChange={(v) => onChange({
                  ...value,
                  outboundChannel: v === OUTBOUND_CHANNEL_NONE ? "" : v,
                  outboundTarget: v === OUTBOUND_CHANNEL_NONE ? "" : value.outboundTarget,
                })}
              >
                <SelectTrigger>
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
                <Label>{t("room.definitions.outboundTarget")}</Label>
                <Input placeholder={t("room.definitions.outboundTargetPlaceholder")} value={value.outboundTarget} onChange={(e) => onChange({ ...value, outboundTarget: e.target.value })} />
              </div>
            ) : null}
          </div>
          {(!value.outboundChannel || value.outboundChannel === OUTBOUND_CHANNEL_NONE) && (
            <p className="text-xs text-muted-foreground">{t("room.definitions.outboundChannelNoneHelp")}</p>
          )}
        </>
      )}
    </div>
  );
}

type DefinitionPayload = {
  name: string; matchingPrompt: string; interpretationPrompt: string;
  action: "backlog" | "conversation";
  contextPrompt: string | null; outboundChannel: string | null; outboundTarget: string | null;
};

/** What the engine stores of a form: a conversation's context and channel only when they apply. */
function payloadOf(form: DefinitionFormState): DefinitionPayload {
  const isConversation = form.action === "conversation";
  const channelSet = isConversation && !!form.outboundChannel;
  return {
    name: form.name,
    matchingPrompt: form.matchingPrompt,
    interpretationPrompt: form.interpretationPrompt,
    action: form.action,
    contextPrompt: isConversation ? form.contextPrompt : null,
    outboundChannel: channelSet ? form.outboundChannel : null,
    outboundTarget: channelSet ? form.outboundTarget : null,
  };
}

/** One event definition of a source, or a new one (`definition` null): fields in a drawer, delete with confirmation. */
function DefinitionSheet({
  open,
  definition,
  onOpenChange,
  onSave,
  onDelete,
}: {
  open: boolean;
  /** The definition being edited; null while creating. */
  definition: EventDefinition | null;
  onOpenChange: (open: boolean) => void;
  onSave: (payload: DefinitionPayload) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<DefinitionFormState>(definition ? formOf(definition) : EMPTY_DEFINITION);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <>
      <ListDrawer
        open={open}
        onOpenChange={onOpenChange}
        title={definition ? definition.name : t("room.definitions.add")}
        description={definition ? definition.matchingPrompt : t("room.definitions.title")}
        header={
          definition && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Badge variant="secondary">{actionLabel(definition.action, t)}</Badge>
            </div>
          )
        }
        destructive={definition && <DrawerDeleteButton onClick={() => setConfirmDelete(true)} />}
        primary={
          <Button onClick={() => onSave(payloadOf(form))} disabled={!form.name.trim()}>
            {definition ? t("common.save") : t("common.add")}
          </Button>
        }
      >
        <DefinitionFields value={form} onChange={setForm} />
      </ListDrawer>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("room.definition.deleteConfirm")}
        confirmLabel={t("common.delete")}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
      />
    </>
  );
}

interface Props {
  /** The source being shown; null keeps the drawer closed. */
  source: EventSource | null;
  /**
   * The revealed webhook URL for this source, or `undefined` while it has
   * not been fetched yet (the parent fetches it when the drawer opens, not
   * eagerly for every source in the list).
   */
  webhookUrl: string | undefined;
  onClose: () => void;
  onCopyWebhook: (url: string) => void;
  onRotateToken: (id: string) => void;
  onUpdateSource: (id: string, data: { name?: string; config?: Record<string, unknown> }) => void;
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
  /** Switches a definition on or off; rejects when the engine refuses, so the switch goes back. */
  onToggleDefinition: (sourceId: string, data: DefinitionPayload & { enabled: boolean }, defId: string) => Promise<void>;
}

/**
 * One webhook source, opened from its row: its name, the webhook URL (copy,
 * rotate), the authentication secret and its event definitions, each of which
 * opens a drawer of its own.
 */
export function EventSourceSheet({
  source, webhookUrl, onClose, onCopyWebhook, onRotateToken,
  onUpdateSource, onDeleteSource, onAddDefinition, onUpdateDefinition, onDeleteDefinition, onToggleDefinition,
}: Props) {
  const { t } = useI18n();
  const [name, setName] = useState(source?.name ?? "");
  const [shown, setShown] = useState(source?.id ?? null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // `"new"` while a definition is being added, otherwise the id of the one open.
  const [openDefinition, setOpenDefinition] = useState<string | "new" | null>(null);

  // Another source opened: start from its name.
  if ((source?.id ?? null) !== shown) {
    setShown(source?.id ?? null);
    setName(source?.name ?? "");
  }

  const definition = source?.definitions.find((d) => d.id === openDefinition) ?? null;
  const nameChanged = source !== null && name.trim() !== "" && name !== source.name;

  return (
    <>
      <ListDrawer
        open={source !== null}
        onOpenChange={(open) => !open && onClose()}
        title={source?.name ?? ""}
        description={source ? t("room.sources.definitionsCount", { count: source.definitions.length }) : ""}
        header={source && <div className="flex flex-wrap gap-2 pt-1"><Badge variant="secondary">{source.sourceType}</Badge></div>}
        destructive={source && <DrawerDeleteButton onClick={() => setConfirmDelete(true)} />}
        primary={
          <Button
            disabled={!nameChanged}
            onClick={() => source && onUpdateSource(source.id, { name })}
          >
            {t("common.save")}
          </Button>
        }
      >
        {source && (
          <>
            <div className="space-y-2">
              <Label htmlFor="source-name">{t("room.sources.name")}</Label>
              <Input id="source-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("room.sources.webhookUrl")}</Label>
              <code className="block break-all rounded bg-muted px-2 py-1 text-xs">
                {webhookUrl ?? t("room.sources.webhookUrlLoading")}
              </code>
              <div className="flex gap-2 pt-1">
                {webhookUrl && (
                  <Button size="sm" variant="outline" onClick={() => onCopyWebhook(webhookUrl)}>
                    <Copy className="size-4" aria-hidden />
                    {t("common.copy")}
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setConfirmRotate(true)}>
                  <RotateCcw className="size-4" aria-hidden />
                  {t("room.sources.rotateToken")}
                </Button>
              </div>
            </div>

            <WebhookAuthSection
              currentMasked={typeof source.config?.authKey === "string" ? source.config.authKey : ""}
              onSave={(authKey) => onUpdateSource(source.id, { config: { authKey } })}
            />

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{t("room.definitions.title")}</h3>
                <Button size="sm" variant="outline" onClick={() => setOpenDefinition("new")}>
                  <Plus className="size-4" aria-hidden />
                  {t("room.definitions.add")}
                </Button>
              </div>
              {source.definitions.length > 0 && (
                <SwitchList
                  rows={source.definitions}
                  rowKey={(def) => def.id}
                  name={(def) => def.name}
                  nameHeader={t("room.definitions.name")}
                  searchText={(def) => [actionLabel(def.action, t)]}
                  columns={[
                    {
                      header: t("room.definitions.action"),
                      className: "w-36",
                      cell: (def) => <Badge variant="secondary">{actionLabel(def.action, t)}</Badge>,
                    },
                  ]}
                  isOn={(def) => def.enabled}
                  onToggle={(def, enabled) => onToggleDefinition(source.id, { ...payloadOf(formOf(def)), enabled }, def.id)}
                  switchLabel={(def) => t("common.activeNamed", { name: def.name })}
                  onOpen={(def) => setOpenDefinition(def.id)}
                  selectedKey={openDefinition}
                />
              )}
            </section>
          </>
        )}
      </ListDrawer>

      {source && openDefinition !== null && (
        <DefinitionSheet
          key={openDefinition}
          open
          definition={definition}
          onOpenChange={(open) => !open && setOpenDefinition(null)}
          onSave={(payload) => {
            if (definition) {
              onUpdateDefinition(source.id, definition.id, { ...payload, enabled: definition.enabled });
            } else {
              const channelSet = payload.outboundChannel !== null;
              onAddDefinition(source.id, {
                ...payload,
                contextPrompt: payload.contextPrompt ?? undefined,
                outboundChannel: channelSet ? payload.outboundChannel ?? undefined : undefined,
                outboundTarget: channelSet ? payload.outboundTarget ?? undefined : undefined,
              });
            }
            setOpenDefinition(null);
          }}
          onDelete={() => {
            if (definition) onDeleteDefinition(source.id, definition.id);
            setOpenDefinition(null);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title={t("room.sources.rotateToken")}
        description={t("room.sources.rotateConfirm")}
        confirmLabel={t("room.sources.rotateToken")}
        onConfirm={() => {
          setConfirmRotate(false);
          if (source) onRotateToken(source.id);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("room.source.deleteConfirm")}
        confirmLabel={t("common.delete")}
        onConfirm={() => {
          setConfirmDelete(false);
          if (source) onDeleteSource(source.id);
          onClose();
        }}
      />
    </>
  );
}

function actionLabel(action: EventDefinition["action"], t: (key: TranslationKey) => string): string {
  return action === "conversation" ? t("room.definitions.actionConversation") : t("room.definitions.actionBacklog");
}
