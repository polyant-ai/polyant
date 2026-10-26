// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { api, getUserErrorMessage } from "@/lib/api";
import type { RoomConfigResponse } from "@/lib/api-types";
import { useI18n } from "@/lib/i18n/context";
import { RoomConfigSection, type RoomFormState } from "./room-config-section";
import { BacklogSection, type BacklogEvent } from "./room-backlog-section";
import { ActivityLogSection, type ActivityLog } from "./room-activity-section";
import { useResource } from "@/hooks/use-resource";
import { usePageSaveAction } from "./page-actions-context";
import { useDraft } from "./use-draft";

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

const NO_ACTIVITY: ActivityLog[] = [];
const NO_BACKLOG: BacklogEvent[] = [];

function isConfiguredRoom(
  room: RoomConfigResponse | null,
): room is RoomConfigResponse & Required<Pick<RoomConfig, "id" | "enabled" | "prompt" | "outboundChannel" | "outboundTarget" | "evalIntervalMinutes">> & { configured: true } {
  return room?.configured === true && typeof room.id === "string";
}

export function RoomTab({ slug }: Props) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [backlogStatus, setBacklogStatus] = useState("pending");

  const { data, loading, reload } = useResource(["room", slug], async () => {
    const roomRes = await api.room.get(slug).catch(() => null);
    if (!isConfiguredRoom(roomRes)) return { room: null, activity: [] as ActivityLog[] };
    const activity = await api.room.activity(slug, { limit: 50 });
    return { room: roomRes as RoomConfig, activity: activity ?? [] };
  });
  const room = data?.room ?? null;
  const activity = data?.activity ?? NO_ACTIVITY;

  // The backlog follows the status filter, and only exists once the room does.
  const { data: backlogData } = useResource(room ? ["room-backlog", slug, backlogStatus] : null, () =>
    api.room.backlog(slug, { status: backlogStatus }).catch(() => ({ events: [] as BacklogEvent[] })),
  );
  const backlog = backlogData?.events ?? NO_BACKLOG;

  const baseline: RoomFormState = room
    ? {
        enabled: room.enabled,
        prompt: room.prompt ?? "",
        outboundChannel: room.outboundChannel ?? "",
        outboundTarget: room.outboundTarget ?? "",
        evalIntervalMinutes: room.evalIntervalMinutes ?? 5,
      }
    : EMPTY_ROOM_FORM;
  const { draft: roomForm, set, isDirty } = useDraft(baseline);
  const setRoomForm = (next: RoomFormState) => {
    for (const field of Object.keys(next) as (keyof RoomFormState)[]) set(field, next[field]);
  };

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
      reload();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRoom() {
    try {
      await api.room.delete(slug);
      toast.success(t("room.deleted"));
      reload();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("room.deleteFailed")));
    }
  }

  usePageSaveAction({ isDirty, saving, onSave: handleSaveRoom });

  if (loading && data === undefined) {
    return (
      <div className="max-w-3xl space-y-4">
        <Skeleton className="h-48 rounded-lg" />
        <Skeleton className="h-32 rounded-lg" />
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
