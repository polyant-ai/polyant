// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test — requires real SendGrid credentials in .env:
 *   SENDGRID_API_KEY, SENDGRID_FROM_EMAIL
 *
 * Run with:
 *   npm run test:integration -w @polyant/engine
 */

import { describe, it, expect } from "vitest";
import "./send-email.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";

const hasCredentials = !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL);

describe.skipIf(!hasCredentials)("sendEmail tool — live SendGrid", () => {
  const def = getToolRegistry().get("sendEmail");
  const to = process.env.SENDGRID_FROM_EMAIL!.trim(); // send to self

  const ctx = {
    instanceId: "test-instance",
    secrets: {},
    audit: createMockAudit(),
    conversationId: "test-conv",
  } as any;

  it("tool is registered", () => {
    expect(def).toBeDefined();
    expect(def!.name).toBe("sendEmail");
    expect(def!.category).toBe("messaging");
  });

  it("sends a plain email (no explicit subject)", async () => {
    const tool = buildTool(def!, ctx) as any;

    const result = await tool.execute({
      to,
      message: "Integration test: plain email sent from Polyant sendEmail tool.\n\nNo explicit subject — first 60 chars used.",
    });

    expect(result).toMatchObject({ success: true, to });
    expect(result.messageLen).toBeGreaterThan(0);
  }, 15_000);

  it("sends an email with an explicit subject", async () => {
    const tool = buildTool(def!, ctx) as any;

    const result = await tool.execute({
      to,
      subject: "Polyant sendEmail — integration test",
      message: "Integration test: email with explicit subject sent from Polyant sendEmail tool.",
    });

    expect(result).toMatchObject({ success: true, to });
  }, 15_000);

  it("blocks recipient not in allowlist", async () => {
    const restrictedCtx = {
      ...ctx,
      secrets: { sendgrid_allowed_recipients: "allowed@example.com" },
    } as any;
    const tool = buildTool(def!, restrictedCtx) as any;

    const result = await tool.execute({
      to: "blocked@example.com",
      message: "This should be blocked.",
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining("allowlist") });
  }, 5_000);

  it("returns error object when SendGrid rejects the request", async () => {
    // Zod validation runs at the AI-model layer, not inside execute() directly.
    // A malformed address bypasses schema validation in direct test calls and
    // reaches SendGrid, which returns 400 Bad Request — the tool catches it and
    // returns { error: "..." } rather than throwing.
    const tool = buildTool(def!, ctx) as any;

    const result = await tool.execute({ to: "not-an-email", message: "test" });

    expect(result).toHaveProperty("error");
    expect(typeof result.error).toBe("string");
  }, 5_000);
});
