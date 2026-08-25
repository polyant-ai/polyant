// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { decrypt } from "../crypto/index.js";
import { importChannels } from "./import.service.js";

// importChannels takes `tx` as a parameter (never imports `db` itself), so a
// minimal fake capturing insert().values() calls is enough — no need to mock
// the database client module. Mirrors import.service.mcp.test.ts.
function makeFakeTx() {
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  };
  return { tx: tx as never, inserted };
}

describe("importChannels — credential-key stripping (#278)", () => {
  it("strips a caller-supplied webhookSecret, imports the WhatsApp channel DISABLED, and warns", async () => {
    const { tx, inserted } = makeFakeTx();

    const warnings = await importChannels(tx, "instance-1", [
      {
        channelType: "whatsapp",
        enabled: true, // was enabled at export time
        config: {
          authMode: "apiKey",
          accountSid: "AC00000000000000000000000000000001",
          apiKeySid: "SK00000000000000000000000000000002",
          apiKeySecret: "sec", // secret — always stripped by the real exporter too
          webhookSecret: "aaaa", // hand-crafted: a caller-chosen inbound authenticator
          whatsappNumber: "+14155238886",
        },
      },
    ]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ instanceId: "instance-1", channelType: "whatsapp", enabled: false });

    const persisted = JSON.parse(decrypt(inserted[0].config as string));
    expect(persisted).not.toHaveProperty("webhookSecret");
    expect(persisted).not.toHaveProperty("apiKeySecret");
    // The non-secret discriminant/setting survive so the admin can finish setup.
    expect(persisted).toMatchObject({ authMode: "apiKey", whatsappNumber: "+14155238886" });

    expect(warnings).toEqual([
      { type: "channel_credentials", message: expect.stringContaining("whatsapp") },
    ]);
  });

  it("strips a caller-supplied authToken and imports the WhatsApp channel DISABLED", async () => {
    const { tx, inserted } = makeFakeTx();

    const warnings = await importChannels(tx, "instance-1", [
      {
        channelType: "whatsapp",
        enabled: true,
        config: {
          authMode: "authToken",
          accountSid: "AC00000000000000000000000000000001",
          authToken: "hand-crafted-token",
          whatsappNumber: "+14155238886",
        },
      },
    ]);

    expect(inserted[0]).toMatchObject({ enabled: false });
    const persisted = JSON.parse(decrypt(inserted[0].config as string));
    expect(persisted).not.toHaveProperty("authToken");

    expect(warnings).toEqual([
      { type: "channel_credentials", message: expect.stringContaining("whatsapp") },
    ]);
  });

  it("imports the credential-less agent channel ENABLED with no warning", async () => {
    const { tx, inserted } = makeFakeTx();

    const warnings = await importChannels(tx, "instance-1", [
      { channelType: "agent", enabled: true, config: {} },
    ]);

    expect(inserted[0]).toMatchObject({ channelType: "agent", enabled: true });
    expect(warnings).toEqual([]);
  });
});
