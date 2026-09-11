// SPDX-License-Identifier: AGPL-3.0-or-later

const mockS3Send = vi.hoisted(() => vi.fn());
// Captures the config the S3Client was constructed with, so tests can assert
// which credential path was taken (static keys vs default provider chain).
const s3ClientArgs = vi.hoisted(() => ({ current: null as any }));
// Sentinel returned by the mocked fromNodeProviderChain() so a test can prove
// the tool fell back to the default provider chain (task role).
const providerChainSentinel = vi.hoisted(() => vi.fn());

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class MockS3Client {
    config: { region: () => Promise<string> };
    send = mockS3Send;
    constructor(cfg: any) {
      s3ClientArgs.current = cfg;
      this.config = { region: async () => cfg?.region ?? "us-east-1" };
    }
  },
  PutObjectCommand: class MockPutObjectCommand { constructor(public params: unknown) {} },
}));
vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: () => providerChainSentinel,
}));
vi.mock("../../utils/error.js", () => ({
  errMsg: (err: unknown) => err instanceof Error ? err.message : String(err),
}));

import { createMockAudit, createMockState } from "../../test-utils.js";
import type { ConversationStateApi } from "../../conversations/state.buffer.js";
import def from "./file-upload.tool.js";

const DEFAULT_SECRETS = {
  aws_access_key_id: "AKIAIOSFODNN7EXAMPLE",
  aws_secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLE",
  aws_region: "eu-west-1",
  s3_bucket_name: "test-bucket",
};

function buildTool(opts?: { secrets?: Record<string, string>; attachments?: any[]; state?: ConversationStateApi }) {
  const ctx = {
    instanceId: "test-instance",
    secrets: opts?.secrets ?? DEFAULT_SECRETS,
    audit: createMockAudit(),
    conversationId: "conv-1",
    attachments: opts?.attachments,
    state: opts?.state,
  } as any;
  return { execute: (input: any) => def.execute(input, ctx), audit: ctx.audit, state: ctx.state };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockS3Send.mockResolvedValue({});
  s3ClientArgs.current = null;
});

describe("fileUpload tool", () => {
  // Registration
  it("registers with correct metadata", () => {
    expect(def.name).toBe("fileUpload");
    expect(def.category).toBe("storage");
    // The bucket and the region first because they are the unconditional pair;
    // the credentials are one of two shapes and `s3_endpoint` is for an
    // S3-compatible server. `attachments/agent-s3.ts` decides between them.
    expect(def.requiredSecrets.map((s) => s.key)).toEqual([
      "s3_bucket_name",
      "aws_region",
      "aws_access_key_id",
      "aws_secret_access_key",
      "s3_use_task_role",
      "s3_endpoint",
    ]);
  });

  // Only the bucket and the region gate tool availability: the supervisor hides
  // a tool whose non-optional secrets are unset, and no agent can hold both
  // credential shapes at once.
  it("marks the credential keys and the endpoint optional, keeping only the bucket and the region required", () => {
    const byKey = Object.fromEntries(def.requiredSecrets.map((s) => [s.key, s]));
    expect(byKey["aws_access_key_id"].optional).toBe(true);
    expect(byKey["aws_secret_access_key"].optional).toBe(true);
    expect(byKey["s3_use_task_role"].optional).toBe(true);
    expect(byKey["s3_endpoint"].optional).toBe(true);
    expect(byKey["s3_bucket_name"].optional).toBeFalsy();
    expect(byKey["aws_region"].optional).toBeFalsy();
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

  // Backward compat: static credentials are passed through to the S3 client.
  it("uses static credentials when configured", async () => {
    const { execute } = buildTool({
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/png", fileName: "a.png" }],
    });

    await execute({ attachmentIndex: 0, base64Data: null, mimeType: null, filename: null });

    expect(s3ClientArgs.current.region).toBe("eu-west-1");
    expect(s3ClientArgs.current.credentials).toEqual({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLE",
    });
  });

  // Cross-account / task-role path: no static credentials + explicit opt-in →
  // default provider chain (task role).
  it("uses the default provider chain when opted in via s3_use_task_role", async () => {
    const { execute } = buildTool({
      secrets: { s3_bucket_name: "xacct-bucket", aws_region: "us-east-1", s3_use_task_role: "true" },
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/png", fileName: "a.png" }],
    });

    const result = (await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    })) as { key: string; url: string };

    // Uploaded successfully using the provider-chain credentials sentinel.
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(s3ClientArgs.current.credentials).toBe(providerChainSentinel);
    // The region is a required secret now, so it is on the client explicitly
    // rather than left to the SDK's environment resolution.
    expect(s3ClientArgs.current.region).toBe("us-east-1");
    expect(result.url).toBe("https://xacct-bucket.s3.us-east-1.amazonaws.com/test-instance/conv-1/a.png");
  });

  // Region secret still wins over the client-resolved region.
  it("uses the configured region for the URL when present", async () => {
    const { execute } = buildTool({
      secrets: { s3_bucket_name: "b", aws_region: "ap-south-1", s3_use_task_role: "1" },
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/png", fileName: "a.png" }],
    });

    const result = (await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    })) as { url: string };

    expect(s3ClientArgs.current.credentials).toBe(providerChainSentinel);
    expect(result.url).toBe("https://b.s3.ap-south-1.amazonaws.com/test-instance/conv-1/a.png");
  });

  // Bucket is the only hard requirement.
  it("returns an error when the bucket is not configured", async () => {
    const { execute } = buildTool({
      secrets: {},
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/png" }],
    });

    const result = (await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    })) as { error: string };

    expect(result.error).toContain("s3_bucket_name");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  // Security: no silent task-role use. Bucket set but no creds and no opt-in → error.
  it("errors (no silent task-role write) when creds and opt-in are both absent", async () => {
    const { execute } = buildTool({
      secrets: { s3_bucket_name: "b", aws_region: "eu-west-1" },
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/png" }],
    });

    const result = (await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    })) as { error: string };

    expect(result.error).toContain("s3_use_task_role");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  // Security: partial static credentials are a hard error, not a silent fallback.
  it("errors on incomplete static credentials (only access key id)", async () => {
    const { execute } = buildTool({
      secrets: { s3_bucket_name: "b", aws_region: "eu-west-1", aws_access_key_id: "AKIA..." },
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/png" }],
    });

    const result = (await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    })) as { error: string };

    expect(result.error).toContain("incomplete");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  // Audit records which identity performed the write (incident response).
  it("records credentialSource in the audit log", async () => {
    const staticTool = buildTool({
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/png", fileName: "a.png" }],
    });
    await staticTool.execute({ attachmentIndex: 0, base64Data: null, mimeType: null, filename: null });
    expect(staticTool.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ credentialSource: "static" }),
      }),
    );

    const taskRoleTool = buildTool({
      secrets: { s3_bucket_name: "b", aws_region: "eu-west-1", s3_use_task_role: "true" },
      attachments: [{ type: "image", data: Buffer.from("img"), mimeType: "image/png", fileName: "a.png" }],
    });
    await taskRoleTool.execute({ attachmentIndex: 0, base64Data: null, mimeType: null, filename: null });
    expect(taskRoleTool.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ credentialSource: "task-role" }),
      }),
    );
  });

  // Display URL percent-encodes key segments (raw Key sent to S3 is unchanged).
  it("percent-encodes the filename in the returned URL", async () => {
    const { execute } = buildTool({
      attachments: [
        { type: "file", data: Buffer.from("x"), mimeType: "application/pdf", fileName: "a b#c?.pdf" },
      ],
    });

    const result = (await execute({
      attachmentIndex: 0,
      base64Data: null,
      mimeType: null,
      filename: null,
    })) as { key: string; url: string };

    // Raw key keeps the literal filename (path separators already stripped).
    expect(result.key).toBe("test-instance/conv-1/a b#c?.pdf");
    // URL encodes the space, '#' and '?' so the link stays well-formed.
    expect(result.url).toContain("/test-instance/conv-1/a%20b%23c%3F.pdf");
    expect(result.url).not.toContain("#");
    expect(result.url).not.toContain("?");
  });
});
