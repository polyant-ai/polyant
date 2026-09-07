// SPDX-License-Identifier: AGPL-3.0-or-later

import { instanceRoom } from "../room/room.schema.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { TxClient } from "./import.types.js";

export async function importRoom(
  tx: TxClient,
  instanceId: string,
  room: NonNullable<ExportInstanceData["room"]>,
): Promise<void> {
  await tx
    .insert(instanceRoom)
    .values({
      instanceId,
      enabled: room.enabled,
      prompt: room.prompt,
      outboundChannel: room.outboundChannel,
      outboundTarget: room.outboundTarget,
      evalIntervalMinutes: room.evalIntervalMinutes,
    })
    .onConflictDoUpdate({
      target: [instanceRoom.instanceId],
      set: {
        enabled: room.enabled,
        prompt: room.prompt,
        outboundChannel: room.outboundChannel,
        outboundTarget: room.outboundTarget,
        evalIntervalMinutes: room.evalIntervalMinutes,
        updatedAt: new Date(),
      },
    });
}
