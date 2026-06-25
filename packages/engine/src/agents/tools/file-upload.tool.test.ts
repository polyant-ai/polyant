// SPDX-License-Identifier: AGPL-3.0-or-later

const mockS3Send = vi.hoisted(() => vi.fn());

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class MockS3Client { send = mockS3Send; },
  PutObjectCommand: class MockPutObjectCommand { constructor(public params: unknown) {} },
}));
vi.mock("./registry.js", () => ({
  registerTool: vi.fn(),
}));
vi.mock("../../utils/error.js", () => ({
  errMsg: (err: unknown) => err instanceof Error ? err.message : String(err),
}));

import { registerTool } from "./registry.js";
import { createMockAudit, createMockState } from "../../test-utils.js";
import type { ConversationStateApi } from "../../conversations/state.buffer.js";
import "./file-upload.tool.js";

const def = vi.mocked(registerTool).mock.calls[0][0];

const DEFAULT_SECRETS = {
  aws_access_key_id: "AKIAIOSFODNN7EXAMPLE",
  aws_secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLE",
  aws_region: "eu-west-1",
  s3_bucket_name: "test-bucket",
};

function buildTool(opts?: { secrets?: Record<string, string>; attachments?: any[]; state?: ConversationStateApi }) {
  const ctx = {
    agentId: "test-instance",
    secrets: opts?.secrets ?? DEFAULT_SECRETS,
    audit: createMockAudit(),
    conversationId: "conv-1",
    attachments: opts?.attachments,
    state: opts?.state,
  } as any;
  return { execute: def.create(ctx).execute, audit: ctx.audit, state: ctx.state };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockS3Send.mockResolvedValue({});
});

describe("fileUpload tool", () => {
  // Registration
  it("registers with correct metadata", () => {
    expect(def.name).toBe("fileUpload");
    expect(def.category).toBe("storage");
    expect(def.requiredSecrets).toEqual(["aws_access_key_id", "aws_secret_access_key", "aws_region", "s3_bucket_name"]);
  });

  // Happy path: upload from attachment
  it("uploads attachment to S3 with correct key", async () => {
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("fake-image"), mimeType: "image/jpeg", fileName: "photo.jpg" },
      ],
    });

    const result = await execute({ attachmentIndex: 0, base64Data: null, mimeType: null, filename: null }) as {
      key: string;
      url: string;
      sizeBytes: number;
    };

    expect(result.key).toBe("test-instance/conv-1/photo.jpg");
    expect(result.url).toContain("test-bucket.s3.eu-west-1.amazonaws.com");
    expect(result.sizeBytes).toBe(Buffer.from("fake-image").length);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  // Happy path: upload from base64
  it("uploads base64 data to S3", async () => {
    const data = Buffer.from("hello-world");
    const { execute } = buildTool();

    const result = await execute({
      attachmentIndex: null,
      base64Data: data.toString("base64"),
      mimeType: "application/pdf",
      filename: "doc.pdf",
    }) as { key: string; sizeBytes: number };

    expect(result.key).toBe("test-instance/conv-1/doc.pdf");
    expect(result.sizeBytes).toBe(data.length);
  });

  // Custom filename
  it("uses custom filename when provided", async () => {
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/png", fileName: "original.png" },
      ],
    });

    const result = await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: "custom-name.png",
    }) as { key: string };

    expect(result.key).toBe("test-instance/conv-1/custom-name.png");
  });

  // No file provided
  it("returns error when no file is provided", async () => {
    const { execute } = buildTool();

    const result = await execute({
      attachmentIndex: null,
      base64Data: null,
      mimeType: null,
      filename: null,
    }) as { error: string };

    expect(result.error).toContain("No file provided");
  });

  // Missing attachment index
  it("returns error for invalid attachment index", async () => {
    const { execute } = buildTool({ attachments: [] });

    const result = await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    }) as { error: string };

    expect(result.error).toContain("No attachment found");
  });

  // File too large
  it("rejects files larger than 10 MB", async () => {
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11 MB
    const { execute } = buildTool({
      attachments: [
        { type: "file", data: largeBuffer, mimeType: "application/pdf" },
      ],
    });

    const result = await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    }) as { error: string };

    expect(result.error).toContain("File too large");
  });

  // Attachment without binary data
  it("returns error when attachment has no data", async () => {
    const { execute } = buildTool({
      attachments: [
        { type: "image", mimeType: "image/jpeg", fileName: "photo.jpg" },
      ],
    });

    const result = await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    }) as { error: string };

    expect(result.error).toContain("has no binary data");
  });

  // S3 error
  it("returns error on S3 failure", async () => {
    mockS3Send.mockRejectedValue(new Error("S3 PutObject failed"));
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/png" },
      ],
    });

    const result = await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    }) as { error: string };

    expect(result.error).toContain("S3 PutObject failed");
  });

  // Audit logging
  it("logs audit on successful upload", async () => {
    const { execute, audit } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/png" },
      ],
    });

    await execute({ attachmentIndex: 0, base64Data: null, mimeType: null, filename: null });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "storage.fileUpload",
        success: true,
      }),
    );
  });

  // Context state: persist uploaded file for cross-turn reuse
  it("writes the uploaded file to conversation state on success", async () => {
    const state = createMockState();
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("fake-image"), mimeType: "image/jpeg", fileName: "bolletta.jpg" },
      ],
      state,
    });

    await execute({ attachmentIndex: 0, base64Data: null, mimeType: null, filename: null });

    expect(state.get("lastUploadedFile")).toEqual({
      key: "test-instance/conv-1/bolletta.jpg",
      url: "https://test-bucket.s3.eu-west-1.amazonaws.com/test-instance/conv-1/bolletta.jpg",
      sizeBytes: Buffer.from("fake-image").length,
      mimeType: "image/jpeg",
    });
  });

  // Context state: do not write on failure
  it("does not write to conversation state when the upload fails", async () => {
    mockS3Send.mockRejectedValue(new Error("S3 PutObject failed"));
    const state = createMockState();
    const { execute } = buildTool({
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/png" }],
      state,
    });

    await execute({ attachmentIndex: 0, base64Data: null, mimeType: null, filename: null });

    expect(state.get("lastUploadedFile")).toBeUndefined();
  });

  // UUID filename generation
  it("generates UUID filename when none provided", async () => {
    const { execute } = buildTool({
      attachments: [
        { type: "image", data: Buffer.from("img"), mimeType: "image/jpeg" },
      ],
    });

    const result = await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    }) as { key: string };

    // Key should be: test-instance/conv-1/{uuid}.jpg
    expect(result.key).toMatch(/^test-instance\/conv-1\/[0-9a-f-]+\.jpg$/);
  });
});
