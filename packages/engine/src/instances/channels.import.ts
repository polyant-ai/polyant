// SPDX-License-Identifier: AGPL-3.0-or-later

import { instanceChannels } from "./channels.schema.js";
import { channelConfigSchemas, type ChannelType } from "./channels.store.js";
import { stripSensitiveKeys } from "./channel-config-sanitize.js";
import { encrypt } from "../crypto/index.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { ImportWarning, TxClient } from "./import.types.js";

async function importOneChannel(
  tx: TxClient,
  instanceId: string,
  ch: ExportInstanceData["channels"][number],
): Promise<ImportWarning | null> {
  // Strip credential-like keys BEFORE validation/persistence — never trust
  // the exporter to have done it. A hand-crafted bundle (as opposed to one
  // this codebase produced) could carry a caller-chosen `webhookSecret` for
  // the WhatsApp `apiKey` inbound-auth route; stripping it here means the
  // union below can only ever be satisfied by a genuinely credential-less
  // config, exactly like the invariant `setChannelConfig` enforces on the
  // normal write path (see the NOTE on that function in channels.store.ts).
  const config = stripSensitiveKeys(ch.config ?? {});
  const schema = channelConfigSchemas[ch.channelType as ChannelType];

  // A channel can be safely (re)enabled on import ONLY if its non-secret
  // config alone satisfies the channel's validation schema — i.e. it needs no
  // credentials (today: the `agent` channel, whose config is empty/passthrough).
  // Credentialed channels (telegram/slack/whatsapp) fail this check because the
  // export stripped their secrets, so they stay disabled until reconfigured.
  const canEnable = schema ? schema.safeParse(config).success : false;
  const enabled = ch.enabled && canEnable;
  const hasConfig = Object.keys(config).length > 0;

  await tx
    .insert(instanceChannels)
    .values({
      instanceId,
      channelType: ch.channelType,
      enabled,
      // Persist the non-secret config (encrypted at rest like any channel
      // config) so the admin only has to fill in the missing credentials.
      config: hasConfig ? encrypt(JSON.stringify(config)) : "",
    })
    .onConflictDoNothing();

  if (ch.enabled && !canEnable) {
    return {
      type: "channel_credentials",
      message: `Channel "${ch.channelType}" imported disabled — configure credentials to enable`,
    };
  }
  return null;
}

// Exported for direct unit testing (mirrors importMcpServers in
// mcp-servers.import.ts) — a minimal fake `tx` capturing insert().values()
// calls is enough to verify the credential-stripping behaviour, without
// mocking the whole database client.
export async function importChannels(
  tx: TxClient,
  instanceId: string,
  channels: ExportInstanceData["channels"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  for (const ch of channels) {
    const warning = await importOneChannel(tx, instanceId, ch);
    if (warning) warnings.push(warning);
  }

  return warnings;
}
