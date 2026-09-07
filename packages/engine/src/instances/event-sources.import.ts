// SPDX-License-Identifier: AGPL-3.0-or-later

import { eventSources, eventDefinitions } from "../webhooks/webhooks.schema.js";
import { generateToken } from "../crypto/index.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { ImportWarning, TxClient } from "./import.types.js";

// No `stripSensitiveKeys` call needed here, unlike importChannels: a bundle
// cannot carry an event-source credential even in principle.
// `exportEventSourceSchema` (export.schema.ts) has no `config`/`webhookToken`
// field at all — Zod's default object parsing drops any such key a crafted
// bundle adds — and this function ignores `source.enabled` and never persists
// `source.config`: every imported row is inserted with `config: ""`,
// `enabled: false`, and a freshly server-minted `webhookToken`
// (`generateToken(32)`, same primitive `setChannelConfig` uses for the
// WhatsApp webhook secret), so a bundle-supplied value could never reach
// storage either way.
async function importOneEventSource(
  tx: TxClient,
  instanceId: string,
  source: ExportInstanceData["eventSources"][number],
): Promise<ImportWarning> {
  const webhookToken = generateToken(32);

  const [created] = await tx
    .insert(eventSources)
    .values({
      instanceId,
      name: source.name,
      sourceType: source.sourceType,
      config: "", // empty — user must configure credentials
      enabled: false, // disabled until configured
      webhookToken,
    })
    .returning({ id: eventSources.id });

  for (const def of source.definitions) {
    await tx.insert(eventDefinitions).values({
      eventSourceId: created.id,
      name: def.name,
      matchingPrompt: def.matchingPrompt,
      interpretationPrompt: def.interpretationPrompt,
      action: def.action,
      contextPrompt: def.contextPrompt,
      outboundChannel: def.outboundChannel,
      outboundTarget: def.outboundTarget,
      enabled: def.enabled,
    });
  }

  return {
    type: "event_source_credentials",
    message: `Event source "${source.name}" imported without credentials — configure manually`,
  };
}

export async function importEventSources(
  tx: TxClient,
  instanceId: string,
  sources: ExportInstanceData["eventSources"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  for (const source of sources) {
    warnings.push(await importOneEventSource(tx, instanceId, source));
  }

  return warnings;
}
