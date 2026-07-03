// SPDX-License-Identifier: AGPL-3.0-or-later

const mockChat = vi.hoisted(() => vi.fn());

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../ai-gateway/index.js", () => ({
  chat: mockChat,
}));
vi.mock("../../utils/error.js", () => ({
  errMsg: (err: unknown) => err instanceof Error ? err.message : String(err),
}));

import { createMockAudit, createMockState } from "../../test-utils.js";
import type { ConversationStateApi } from "../../conversations/state.buffer.js";
import def from "./verify-document.tool.js";

function buildTool(opts?: { attachments?: any[]; state?: ConversationStateApi }) {
  const ctx = {
    instanceId: "test-instance",
    secrets: {},
    audit: createMockAudit(),
    conversationId: "conv-1",
    attachments: opts?.attachments,
    apiKeys: { openai: "sk-test" },
    provider: "openai",
    state: opts?.state,
  } as any;
  return {
    execute: (input: any) => def.execute(input, ctx),
    audit: ctx.audit,
    state: ctx.state,
  };
}

const VALID_RESULT = {
  isBill: true,
  readabilityScore: 85,
  billType: "electricity",
  confidence: 0.92,
  reason: "Documento Enel Energia chiaramente leggibile",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyDocument tool", () => {
  // Registration
  it("registers with correct metadata", () => {
    expect(def.name).toBe("verifyDocument");
    expect(def.category).toBe("document");
    expect(def.requiredSecrets).toEqual([]);
  });

  // Happy path: valid bill
  it("returns verification result for a valid bill image", async () => {
    mockChat.mockResolvedValue({ text: JSON.stringify(VALID_RESULT) });
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("fake-image"), mimeType: "image/jpeg", fileName: "bill.jpg" },
      ],
    });

    const result = await execute({ attachmentIndex: 0 });

    expect(result).toEqual(VALID_RESULT);
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "fast",
        provider: "openai",
        apiKeys: { openai: "sk-test" },
      }),
      expect.objectContaining({
        conversationId: "conv-1",
        instanceId: "test-instance",
        callType: "service",
      }),
    );
  });

  // Not a bill
  it("returns isBill false for non-bill documents", async () => {
    const notBill = {
      isBill: false,
      readabilityScore: 70,
      billType: null,
      confidence: 0.88,
      reason: "Document appears to be a contract, not a bill",
    };
    mockChat.mockResolvedValue({ text: JSON.stringify(notBill) });
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/png" },
      ],
    });

    const result = await execute({ attachmentIndex: 0 });

    expect(result).toEqual(notBill);
  });

  // No attachment
  it("returns error when no attachment at index", async () => {
    const { execute } = buildTool({ attachments: [] });

    const result = await execute({ attachmentIndex: 0 }) as { error: string };

    expect(result.error).toContain("No attachment found");
    expect(mockChat).not.toHaveBeenCalled();
  });

  // No binary data
  it("returns error when attachment has no data", async () => {
    const { execute } = buildTool({
      attachments: [
        { type: "image", mimeType: "image/jpeg", fileName: "no-data.jpg" },
      ],
    });

    const result = await execute({ attachmentIndex: 0 }) as { error: string };

    expect(result.error).toContain("has no binary data");
  });

  // Unsupported type
  it("returns error for unsupported attachment types", async () => {
    const { execute } = buildTool({
      attachments: [
        { type: "audio", data: Buffer.from("audio"), mimeType: "audio/mpeg" },
      ],
    });

    const result = await execute({ attachmentIndex: 0 }) as { error: string };

    expect(result.error).toContain("Unsupported");
  });

  // Malformed LLM JSON
  it("returns error when LLM returns invalid JSON", async () => {
    mockChat.mockResolvedValue({ text: "This is not valid JSON..." });
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/jpeg" },
      ],
    });

    const result = await execute({ attachmentIndex: 0 }) as { error: string; raw: string };

    expect(result.error).toContain("invalid LLM response");
    expect(result.raw).toContain("not valid JSON");
  });

  // LLM returns JSON with wrong shape
  it("returns error when LLM JSON has wrong schema", async () => {
    mockChat.mockResolvedValue({ text: JSON.stringify({ foo: "bar" }) });
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/jpeg" },
      ],
    });

    const result = await execute({ attachmentIndex: 0 }) as { error: string };

    expect(result.error).toContain("invalid structure");
  });

  // LLM returns JSON wrapped in code fences
  it("strips markdown code fences from LLM response", async () => {
    mockChat.mockResolvedValue({ text: "```json\n" + JSON.stringify(VALID_RESULT) + "\n```" });
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/jpeg" },
      ],
    });

    const result = await execute({ attachmentIndex: 0 });

    expect(result).toEqual(VALID_RESULT);
  });

  // LLM call fails
  it("returns error when LLM call throws", async () => {
    mockChat.mockRejectedValue(new Error("Provider unavailable"));
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/jpeg" },
      ],
    });

    const result = await execute({ attachmentIndex: 0 }) as { error: string };

    expect(result.error).toBe("Provider unavailable");
  });

  // PDF attachment
  it("handles PDF attachments as file type", async () => {
    mockChat.mockResolvedValue({ text: JSON.stringify(VALID_RESULT) });
    const { execute } = buildTool({
      attachments: [
        { type: "file", data: Buffer.from("fake-pdf"), mimeType: "application/pdf", fileName: "bill.pdf" },
      ],
    });

    const result = await execute({ attachmentIndex: 0 });

    expect(result).toEqual(VALID_RESULT);
    // Verify the chat call includes a file part (not image)
    const chatCall = mockChat.mock.calls[0][0];
    const content = chatCall.messages[0].content;
    expect(content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file", mimeType: "application/pdf" }),
      ]),
    );
  });

  // Audit logging
  it("logs audit on successful verification", async () => {
    mockChat.mockResolvedValue({ text: JSON.stringify(VALID_RESULT) });
    const { execute, audit } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/jpeg" },
      ],
    });

    await execute({ attachmentIndex: 0 });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "document.verifyDocument",
        success: true,
        details: expect.objectContaining({
          isBill: true,
          readabilityScore: 85,
        }),
      }),
    );
  });

  // Context state: persist verdict for cross-turn reuse
  it("writes the verdict to conversation state on success", async () => {
    mockChat.mockResolvedValue({ text: JSON.stringify(VALID_RESULT) });
    const state = createMockState();
    const { execute } = buildTool({
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/jpeg" }],
      state,
    });

    await execute({ attachmentIndex: 0 });

    expect(state.get("lastVerifiedDocument")).toEqual({
      isBill: VALID_RESULT.isBill,
      readabilityScore: VALID_RESULT.readabilityScore,
      billType: VALID_RESULT.billType,
      confidence: VALID_RESULT.confidence,
    });
  });

  // Context state: do not write an invalid verdict
  it("does not write to conversation state when the verdict is invalid", async () => {
    mockChat.mockResolvedValue({ text: JSON.stringify({ foo: "bar" }) });
    const state = createMockState();
    const { execute } = buildTool({
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/jpeg" }],
      state,
    });

    await execute({ attachmentIndex: 0 });

    expect(state.get("lastVerifiedDocument")).toBeUndefined();
  });

  it("logs audit on malformed response", async () => {
    mockChat.mockResolvedValue({ text: "not json" });
    const { execute, audit } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/jpeg" },
      ],
    });

    await execute({ attachmentIndex: 0 });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "document.verifyDocument",
        success: false,
      }),
    );
  });
});
