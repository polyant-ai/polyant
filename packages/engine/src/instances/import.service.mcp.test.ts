// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { decrypt } from "../crypto/index.js";
import { importMcpServers } from "./import.service.js";

// importMcpServers takes `tx` as a parameter (never imports `db` itself), so a
// minimal fake capturing insert().values() calls is enough — no need to mock
// the database client module.
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

describe("importMcpServers", () => {
  it("imports a static server DISABLED with a mcp_server_credentials warning when its stripped config fails validation (no token)", async () => {
    const { tx, inserted } = makeFakeTx();

    const warnings = await importMcpServers(tx, "instance-1", [
      {
        slug: "github",
        name: "GitHub",
        url: "https://mcp.example.com",
        authMode: "static",
        enabled: true, // was enabled at export time
        config: { auth: { type: "bearer" } }, // token stripped by the exporter
      },
    ]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ instanceId: "instance-1", slug: "github", enabled: false });

    expect(warnings).toEqual([
      { type: "mcp_server_credentials", message: expect.stringContaining("github") },
    ]);
  });

  it("imports an oauth server ENABLED (no warning) when its config has no required secret", async () => {
    const { tx, inserted } = makeFakeTx();

    const warnings = await importMcpServers(tx, "instance-1", [
      {
        slug: "linear",
        name: "Linear",
        url: "https://mcp.linear.app",
        authMode: "oauth",
        enabled: true,
        config: { scopes: ["read"] },
      },
    ]);

    expect(inserted[0]).toMatchObject({ enabled: true });
    expect(warnings).toEqual([]);
  });

  it("does not warn for a server that was already disabled at export time", async () => {
    const { tx, inserted } = makeFakeTx();

    const warnings = await importMcpServers(tx, "instance-1", [
      {
        slug: "jira",
        name: "Jira",
        url: "https://mcp.jira.example.com",
        authMode: "static",
        enabled: false,
        config: { auth: { type: "bearer" } },
      },
    ]);

    expect(inserted[0]).toMatchObject({ enabled: false });
    expect(warnings).toEqual([]);
  });

  it("skips a server with an unknown authMode entirely (not inserted) and warns", async () => {
    const { tx, inserted } = makeFakeTx();

    const warnings = await importMcpServers(tx, "instance-1", [
      {
        slug: "rogue",
        name: "Rogue",
        url: "https://mcp.example.com",
        authMode: "oidc", // not a member of MCP_AUTH_MODES
        enabled: true,
        config: {},
      },
    ]);

    expect(inserted).toHaveLength(0);
    expect(warnings).toEqual([
      { type: "mcp_server_invalid", message: expect.stringContaining("rogue") },
    ]);
  });

  it("persists only the non-secret allowList when the stripped config fails validation (never the raw bundle blob)", async () => {
    const { tx, inserted } = makeFakeTx();

    await importMcpServers(tx, "instance-1", [
      {
        slug: "github",
        name: "GitHub",
        url: "https://mcp.example.com",
        authMode: "static",
        enabled: true,
        config: { auth: { type: "bearer" }, allowList: ["create_issue"] },
      },
    ]);

    const persisted = JSON.parse(decrypt(inserted[0].config as string));
    expect(persisted).toEqual({ allowList: ["create_issue"] });
  });

  it("persists the SCHEMA-VALIDATED config, dropping unknown keys a crafted bundle smuggled in", async () => {
    const { tx, inserted } = makeFakeTx();

    await importMcpServers(tx, "instance-1", [
      {
        slug: "linear",
        name: "Linear",
        url: "https://mcp.linear.app",
        authMode: "oauth",
        enabled: true,
        config: {
          scopes: ["read"],
          // Not part of oauthConfigSchema — must never reach the encrypted config.
          rogueKey: "steer-the-flow",
        },
      },
    ]);

    const persisted = JSON.parse(decrypt(inserted[0].config as string));
    expect(persisted).toEqual({ scopes: ["read"] });
    expect(persisted).not.toHaveProperty("rogueKey");
  });

  it("skips a server whose URL is not http(s) (SSRF guard) and warns", async () => {
    const { tx, inserted } = makeFakeTx();

    const warnings = await importMcpServers(tx, "instance-1", [
      { slug: "evil", name: "Evil", url: "file:///etc/passwd", authMode: "none", enabled: true, config: {} },
    ]);

    expect(inserted).toHaveLength(0);
    expect(warnings).toEqual([
      { type: "mcp_server_invalid", message: expect.stringContaining("evil") },
    ]);
  });

  it("skips a link-local/metadata URL in production (SSRF guard) instead of importing it enabled", async () => {
    const { tx, inserted } = makeFakeTx();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const warnings = await importMcpServers(tx, "instance-1", [
        {
          slug: "metadata",
          name: "Metadata",
          url: "http://169.254.169.254/latest/meta-data/",
          authMode: "none",
          enabled: true,
          config: {},
        },
      ]);

      expect(inserted).toHaveLength(0);
      expect(warnings).toEqual([
        { type: "mcp_server_invalid", message: expect.stringContaining("metadata") },
      ]);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
