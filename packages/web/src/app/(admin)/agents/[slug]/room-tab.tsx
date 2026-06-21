// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, getUserErrorMessage } from "@/lib/api";
import type { RoomConfigResponse } from "@/lib/api-types";
import { useI18n } from "@/lib/i18n/context";
import { RoomConfigSection, type RoomFormState } from "./room-config-section";
import { BacklogSection, type BacklogEvent } from "./room-backlog-section";
import { ActivityLogSection, type ActivityLog } from "./room-activity-section";
import { usePageSaveAction } from "./page-actions-context";

interface Props {
  slug: string;
}

interface RoomConfig {
  id: string;
  enabled: boolean;
  prompt: string;
  outboundChannel: string | null;
  outboundTarget: string | null;
  evalIntervalMinutes: number;
}

const EMPTY_ROOM_FORM: RoomFormState = {
  enabled: false,
  prompt: "",
  outboundChannel: "",
  outboundTarget: "",
  evalIntervalMinutes: 5,
};

function isConfiguredRoom(
  room: RoomConfigResponse | null,
): room is RoomConfigResponse & Required<Pick<RoomConfig, "id" | "enabled" | "prompt" | "outboundChannel" | "outboundTarget" | "evalIntervalMinutes">> & { configured: true } {
  return room?.configured === true && typeof room.id === "string";
}

export function RoomTab({ slug }: Props) {
  const { t } = useI18n();
  const [room, setRoom] = useState<RoomConfig | null>(null);
  const [backlog, setBacklog] = useState<BacklogEvent[]>([]);
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [backlogStatus, setBacklogStatus] = useState("pending");

  const [roomForm, setRoomForm] = useState<RoomFormState>(EMPTY_ROOM_FORM);

  useEffect(() => {
    loadAll();
  }, [slug]);

  useEffect(() => {
    if (!room) return;
    api.room.backlog(slug, { status: backlogStatus }).then((res) => {
      setBacklog(res.events ?? []);
    }).catch(() => setBacklog([]));
  }, [backlogStatus, room, slug]);

  async function loadAll() {
    setLoading(true);
    try {
      const roomRes = await api.room.get(slug).catch(() => null);
      if (isConfiguredRoom(roomRes)) {
        setRoom(roomRes);
        setRoomForm({
          enabled: roomRes.enabled,
          prompt: roomRes.prompt ?? "",
          outboundChannel: roomRes.outboundChannel ?? "",
          outboundTarget: roomRes.outboundTarget ?? "",
          evalIntervalMinutes: roomRes.evalIntervalMinutes ?? 5,
        });
        const [backlogRes, activityRes] = await Promise.all([
          api.room.backlog(slug, { status: backlogStatus }),
          api.room.activity(slug, { limit: 50 }),
        ]);
        setBacklog(backlogRes.events ?? []);
        setActivity(activityRes ?? []);
      } else {
        setRoom(null);
        setRoomForm(EMPTY_ROOM_FORM);
        setBacklog([]);
        setActivity([]);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveRoom() {
    setSaving(true);
    try {
      await api.room.upsert(slug, {
        enabled: roomForm.enabled,
        prompt: roomForm.prompt,
        outboundChannel: roomForm.outboundChannel || null,
        outboundTarget: roomForm.outboundTarget || null,
        evalIntervalMinutes: roomForm.evalIntervalMinutes,
      });
      toast.success(t("room.saved"));
      await loadAll();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRoom() {
    try {
      await api.room.delete(slug);
      setRoom(null);
      setRoomForm(EMPTY_ROOM_FORM);
      setBacklog([]);
      setActivity([]);
      toast.success(t("room.deleted"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.deleteFailed")));
    }
  }

  const baseline: RoomFormState = room
    ? {
        enabled: room.enabled,
        prompt: room.prompt ?? "",
        outboundChannel: room.outboundChannel ?? "",
        outboundTarget: room.outboundTarget ?? "",
        evalIntervalMinutes: room.evalIntervalMinutes ?? 5,
      }
    : EMPTY_ROOM_FORM;

  const isDirty =
    roomForm.enabled !== baseline.enabled ||
    roomForm.prompt !== baseline.prompt ||
    roomForm.outboundChannel !== baseline.outboundChannel ||
    roomForm.outboundTarget !== baseline.outboundTarget ||
    roomForm.evalIntervalMinutes !== baseline.evalIntervalMinutes;

  usePageSaveAction({ isDirty, saving, onSave: handleSaveRoom });

  if (loading) {
    return (
      <div className="max-w-3xl animate-pulse space-y-4">
        <div className="h-48 rounded-lg bg-muted" />
        <div className="h-32 rounded-lg bg-muted" />
      </div>
    );
  }

  if (!room) {
    return (
      <div className="max-w-3xl space-y-8">
        <RoomConfigSection form={roomForm} onChange={setRoomForm} isNew />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-8">
      <RoomConfigSection
        form={roomForm}
        onChange={setRoomForm}
        onDelete={handleDeleteRoom}
        isNew={false}
      />

      <BacklogSection backlog={backlog} status={backlogStatus} onStatusChange={setBacklogStatus} />
      <ActivityLogSection activity={activity} />
    </div>
  );
}
