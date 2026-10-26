// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadFailed } from "@/components/ui/load-failed";
import { useResource } from "@/hooks/use-resource";
import { Badge } from "@/components/ui/badge";
import { ListDrawer } from "@/components/list-drawer";
import { ListEmpty, ListLoading } from "@/components/list-states";
import { SwitchList } from "@/components/switch-list";
import { api, getUserErrorMessage } from "@/lib/api";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useI18n } from "@/lib/i18n/context";
import { EventSourceSheet, type EventSource } from "./room-event-source-sheet";
import { SectionActions } from "./section-actions";

const EVENT_SOURCE_TYPES = [
  { value: "webhook", label: "Webhook" },
] as const;

interface Props {
  slug: string;
}

const NO_SOURCES: EventSource[] = [];

type DefinitionUpdate = {
  name: string; matchingPrompt: string; interpretationPrompt: string; enabled: boolean;
  action?: string; contextPrompt?: string | null; outboundChannel?: string | null; outboundTarget?: string | null;
};

export function TriggersWebhooksTab({ slug }: Props) {
  const { t } = useI18n();
  const { copy } = useCopyToClipboard();
  const { data, error, loading, reload: loadSources } = useResource(["event-sources", slug], async () =>
    (await api.eventSources.list(slug)) as EventSource[],
  );
  const sources = data ?? NO_SOURCES;
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  // The list endpoint deliberately omits the bearer-equivalent webhook URL
  // (see EventSource in room-event-source-sheet.tsx), so it is fetched on
  // demand per source — never eagerly for the whole list — and cached here.
  const [webhookUrls, setWebhookUrls] = useState<Record<string, string>>({});
  const [newSourceForm, setNewSourceForm] = useState({ name: "", sourceType: "webhook", showForm: false });

  async function handleAddSource() {
    try {
      await api.eventSources.create(slug, {
        name: newSourceForm.name,
        sourceType: newSourceForm.sourceType,
        config: {},
        enabled: true,
      });
      toast.success(t("room.source.created"));
      setNewSourceForm({ name: "", sourceType: "webhook", showForm: false });
      loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.source.createFailed")));
    }
  }

  async function handleToggleSourceEnabled(id: string, enabled: boolean) {
    try {
      await api.eventSources.update(slug, id, { enabled });
      await loadSources();
      toast.success(enabled ? t("common.enabled") : t("common.disabled"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.source.updateFailed")));
      throw err;
    }
  }

  async function handleDeleteSource(id: string) {
    try {
      await api.eventSources.delete(slug, id);
      toast.success(t("room.source.deleted"));
      setOpenSourceId(null);
      loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.source.deleteFailed")));
    }
  }

  async function handleUpdateSource(id: string, data: { name?: string; config?: Record<string, unknown> }) {
    try {
      await api.eventSources.update(slug, id, data);
      // Read again so a changed config (e.g. the auth secret) shows its masked value.
      loadSources();
      toast.success(t("common.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.source.updateFailed")));
    }
  }

  async function handleRotateToken(id: string) {
    try {
      const res = await api.eventSources.rotateToken(slug, id);
      // The rotate response already carries the fresh URL under ROOM_WRITE,
      // so cache it directly rather than issuing a redundant reveal fetch.
      setWebhookUrls((prev) => ({ ...prev, [id]: res.webhookUrl }));
      toast.success(t("room.sources.copied"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.sources.rotateToken")));
    }
  }

  async function revealWebhookUrl(id: string) {
    try {
      const res = await api.eventSources.webhookUrl(slug, id);
      setWebhookUrls((prev) => ({ ...prev, [id]: res.webhookUrl }));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.sources.revealFailed")));
    }
  }

  /** Opens the source's drawer and, on first open only, fetches its webhook URL. */
  function handleOpenSource(id: string) {
    setOpenSourceId(id);
    if (!webhookUrls[id]) void revealWebhookUrl(id);
  }

  async function handleToggleDefinition(sourceId: string, data: DefinitionUpdate & { enabled: boolean }, defId: string) {
    try {
      await api.eventSources.updateDefinition(slug, sourceId, defId, data);
      await loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.definition.saveFailed")));
      throw err;
    }
  }

  async function handleAddDefinition(sourceId: string, data: {
    name: string; matchingPrompt: string; interpretationPrompt: string;
    action?: string; contextPrompt?: string; outboundChannel?: string; outboundTarget?: string;
  }) {
    try {
      await api.eventSources.createDefinition(slug, sourceId, { ...data, enabled: true });
      toast.success(t("room.definition.created"));
      loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.definition.createFailed")));
    }
  }

  async function handleUpdateDefinition(sourceId: string, defId: string, data: DefinitionUpdate) {
    try {
      await api.eventSources.updateDefinition(slug, sourceId, defId, data);
      toast.success(t("room.definition.saved"));
      loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.definition.saveFailed")));
    }
  }

  async function handleDeleteDefinition(sourceId: string, defId: string) {
    try {
      await api.eventSources.deleteDefinition(slug, sourceId, defId);
      toast.success(t("room.definition.deleted"));
      loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.definition.deleteFailed")));
    }
  }

  async function copyWebhookUrl(url: string) {
    if (await copy(url)) toast.success(t("room.sources.copied"));
  }

  if (error && data === undefined) return <LoadFailed onRetry={loadSources} />;

  if (loading && data === undefined) return <ListLoading className="" />;

  return (
    <div className="space-y-6">
      <SectionActions>
        <Button size="sm" onClick={() => setNewSourceForm((p) => ({ ...p, showForm: true }))}>
          <Plus className="mr-1 size-4" />
          {t("room.sources.add")}
        </Button>
      </SectionActions>

      {sources.length === 0 ? (
        <ListEmpty className="mt-8" title={t("room.sources.empty")} />
      ) : (
        <SwitchList
          rows={sources}
          rowKey={(source) => source.id}
          name={(source) => source.name}
          nameHeader={t("room.sources.name")}
          summary={(source) => source.definitions.map((d) => d.name).join(", ") || undefined}
          searchText={(source) => [source.sourceType]}
          columns={[
            { header: t("room.sources.type"), className: "w-32", cell: (source) => <Badge variant="secondary">{source.sourceType}</Badge> },
            { header: t("room.definitions.title"), className: "w-36", cell: (source) => source.definitions.length },
          ]}
          isOn={(source) => source.enabled}
          onToggle={(source, enabled) => handleToggleSourceEnabled(source.id, enabled)}
          switchLabel={(source) => t("common.activeNamed", { name: source.name })}
          onOpen={(source) => handleOpenSource(source.id)}
          selectedKey={openSourceId}
        />
      )}

      <ListDrawer
        open={newSourceForm.showForm}
        onOpenChange={(open) => !open && setNewSourceForm((p) => ({ ...p, showForm: false }))}
        title={t("room.sources.add")}
        description={t("room.sources.title")}
        primary={
          <Button onClick={handleAddSource} disabled={!newSourceForm.name.trim()}>
            {t("common.add")}
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="new-source-name">{t("room.sources.name")}</Label>
            <Input id="new-source-name" value={newSourceForm.name} onChange={(e) => setNewSourceForm((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>{t("room.sources.type")}</Label>
            <Select value={newSourceForm.sourceType} onValueChange={(v) => setNewSourceForm((p) => ({ ...p, sourceType: v }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_SOURCE_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </ListDrawer>

      <EventSourceSheet
        source={sources.find((source) => source.id === openSourceId) ?? null}
        webhookUrl={openSourceId ? webhookUrls[openSourceId] : undefined}
        onClose={() => setOpenSourceId(null)}
        onCopyWebhook={copyWebhookUrl}
        onRotateToken={handleRotateToken}
        onUpdateSource={handleUpdateSource}
        onDeleteSource={handleDeleteSource}
        onAddDefinition={handleAddDefinition}
        onUpdateDefinition={handleUpdateDefinition}
        onDeleteDefinition={handleDeleteDefinition}
        onToggleDefinition={handleToggleDefinition}
      />
    </div>
  );
}
