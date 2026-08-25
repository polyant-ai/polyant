// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
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
import { api, getUserErrorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { EventSourceCard, type EventSource, type EventDefinition } from "./room-event-source-card";

const EVENT_SOURCE_TYPES = [
  { value: "webhook", label: "Webhook" },
] as const;

interface Props {
  slug: string;
}

export function TriggersWebhooksTab({ slug }: Props) {
  const { t } = useI18n();
  const [sources, setSources] = useState<EventSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  // The list endpoint deliberately omits the bearer-equivalent webhook URL
  // (see EventSource in room-event-source-card.tsx), so it is fetched on
  // demand per source — never eagerly for the whole list — and cached here.
  const [webhookUrls, setWebhookUrls] = useState<Record<string, string>>({});
  const [newSourceForm, setNewSourceForm] = useState({ name: "", sourceType: "webhook", showForm: false });

  useEffect(() => {
    loadSources();
  }, [slug]);

  async function loadSources() {
    setLoading(true);
    try {
      const sources = await api.eventSources.list(slug);
      setSources(sources as EventSource[]);
    } catch {
      setSources([]);
    } finally {
      setLoading(false);
    }
  }

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
      await loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.source.createFailed")));
    }
  }

  async function handleToggleSourceEnabled(id: string, enabled: boolean) {
    try {
      await api.eventSources.update(slug, id, { enabled });
      setSources((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
      toast.success(enabled ? t("common.enabled") : t("common.disabled"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.source.updateFailed")));
    }
  }

  async function handleDeleteSource(id: string) {
    try {
      await api.eventSources.delete(slug, id);
      toast.success(t("room.source.deleted"));
      await loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.source.deleteFailed")));
    }
  }

  async function handleUpdateSource(id: string, data: { name?: string; config?: Record<string, unknown> }) {
    try {
      await api.eventSources.update(slug, id, data);
      // A config change (e.g. the auth secret) must be reloaded so the masked
      // value reflects; a plain name edit can update optimistically.
      if (data.config) {
        await loadSources();
      } else {
        setSources((prev) => prev.map((s) => (s.id === id ? { ...s, ...data } : s)));
      }
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

  /** Expand toggles the row and, on first expand only, fetches its webhook URL. */
  function handleToggleExpand(id: string) {
    const willExpand = !expandedSources[id];
    setExpandedSources((prev) => ({ ...prev, [id]: willExpand }));
    if (willExpand && !webhookUrls[id]) {
      void revealWebhookUrl(id);
    }
  }

  async function handleAddDefinition(sourceId: string, data: {
    name: string; matchingPrompt: string; interpretationPrompt: string;
    action?: string; contextPrompt?: string; outboundChannel?: string; outboundTarget?: string;
  }) {
    try {
      await api.eventSources.createDefinition(slug, sourceId, { ...data, enabled: true });
      toast.success(t("room.definition.created"));
      await loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.definition.createFailed")));
    }
  }

  async function handleUpdateDefinition(sourceId: string, defId: string, data: {
    name: string; matchingPrompt: string; interpretationPrompt: string; enabled: boolean;
    action?: string; contextPrompt?: string | null; outboundChannel?: string | null; outboundTarget?: string | null;
  }) {
    try {
      await api.eventSources.updateDefinition(slug, sourceId, defId, data);
      toast.success(t("room.definition.saved"));
      await loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.definition.saveFailed")));
    }
  }

  async function handleDeleteDefinition(sourceId: string, defId: string) {
    try {
      await api.eventSources.deleteDefinition(slug, sourceId, defId);
      toast.success(t("room.definition.deleted"));
      await loadSources();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.definition.deleteFailed")));
    }
  }

  function copyWebhookUrl(url: string) {
    navigator.clipboard.writeText(url);
    toast.success(t("room.sources.copied"));
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-32 rounded-lg bg-muted" />
        <div className="h-24 rounded-lg bg-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">{t("room.sources.title")}</h3>
        <Button size="sm" variant="outline" onClick={() => setNewSourceForm((p) => ({ ...p, showForm: !p.showForm }))}>
          <Plus className="h-4 w-4 mr-1" />
          {t("room.sources.add")}
        </Button>
      </div>

      {newSourceForm.showForm && (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>{t("room.sources.name")}</Label>
              <Input value={newSourceForm.name} onChange={(e) => setNewSourceForm((p) => ({ ...p, name: e.target.value }))} />
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
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setNewSourceForm((p) => ({ ...p, showForm: false }))}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={handleAddSource} disabled={!newSourceForm.name}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}

      {sources.map((source) => (
        <EventSourceCard
          key={source.id}
          source={source}
          expanded={!!expandedSources[source.id]}
          webhookUrl={webhookUrls[source.id]}
          onToggleExpand={() => handleToggleExpand(source.id)}
          onToggleEnabled={handleToggleSourceEnabled}
          onCopyWebhook={copyWebhookUrl}
          onRotateToken={handleRotateToken}
          onUpdateSource={handleUpdateSource}
          onDeleteSource={handleDeleteSource}
          onAddDefinition={handleAddDefinition}
          onUpdateDefinition={handleUpdateDefinition}
          onDeleteDefinition={handleDeleteDefinition}
        />
      ))}
    </div>
  );
}
