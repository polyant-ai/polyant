// SPDX-License-Identifier: AGPL-3.0-or-later

const mockS3Send = vi.hoisted(() => vi.fn());

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class MockS3Client { send = mockS3Send; },
  PutObjectCommand: class MockPutObjectCommand { constructor(public params: unknown) {} },
  GetObjectCommand: class MockGetObjectCommand { constructor(public params: unknown) {} },
}));

vi.mock("../config.js", () => ({
  config: {
    platformS3: {
      bucket: "platform-bucket",
      region: "eu-west-1",
      accessKeyId: "AKIA_PLATFORM",
      secretAccessKey: "secret_platform",
    },
  },
}));

vi.mock("../utils/mime.js", () => ({
  extensionFromMime: (mime?: string) => {
    if (!mime) return "bin";
    const map: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };
    return map[mime] ?? "bin";
  },
}));

import { uploadAttachment, getAttachmentStream, isPlatformStorageConfigured } from "./platform-storage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockS3Send.mockResolvedValue({});
});

describe("platform-storage", () => {
  describe("isPlatformStorageConfigured", () => {
    it("returns true when platformS3 is configured", () => {
      expect(isPlatformStorageConfigured()).toBe(true);
    });
  });

  describe("uploadAttachment", () => {
    it("uploads buffer to S3 with correct key", async () => {
      const data = Buffer.from("fake-image-data");

      const result = await uploadAttachment(data, {
        type: "image",
        mimeType: "image/jpeg",
        fileName: "photo.jpg",
        agentId: "inst-1",
        conversationId: "conv-1",
      });

      expect(result).not.toBeNull();
      expect(result!.s3Key).toBe("attachments/inst-1/conv-1/photo.jpg");
      expect(result!.type).toBe("image");
      expect(result!.mimeType).toBe("image/jpeg");
      expect(result!.sizeBytes).toBe(data.length);
      expect(mockS3Send).toHaveBeenCalledTimes(1);
    });

    it("generates UUID filename when none provided", async () => {
      const data = Buffer.from("data");

      const result = await uploadAttachment(data, {
        type: "file",
        mimeType: "application/pdf",
        agentId: "inst-1",
        conversationId: "conv-1",
      });

      expect(result).not.toBeNull();
      expect(result!.s3Key).toMatch(/^attachments\/inst-1\/conv-1\/[0-9a-f-]+\.pdf$/);
    });

    it("sanitizes filenames with path separators", async () => {
      const data = Buffer.from("data");

      const result = await uploadAttachment(data, {
        type: "file",
        mimeType: "application/pdf",
        fileName: "../../../evil.pdf",
        agentId: "inst-1",
        conversationId: "conv-1",
      });

      expect(result).not.toBeNull();
      // Path separators are stripped — dots are harmless in S3 keys (path traversal is prevented at the controller)
      expect(result!.s3Key).toBe("attachments/inst-1/conv-1/.._.._.._evil.pdf");
    });

    it("returns metadata with correct structure", async () => {
      const data = Buffer.from("png-data");

      const result = await uploadAttachment(data, {
        type: "image",
        mimeType: "image/png",
        fileName: "screenshot.png",
        agentId: "i",
        conversationId: "c",
      });

      expect(result).toEqual({
        type: "image",
        mimeType: "image/png",
        fileName: "screenshot.png",
        s3Key: "attachments/i/c/screenshot.png",
        sizeBytes: data.length,
      });
    });
  });

  describe("getAttachmentStream", () => {
    it("returns stream and metadata from S3", async () => {
      const fakeBody = { pipe: vi.fn() };
      mockS3Send.mockResolvedValue({
        Body: fakeBody,
        ContentType: "image/jpeg",
        ContentLength: 12345,
      });

      const result = await getAttachmentStream("attachments/inst/conv/file.jpg");

      expect(result.body).toBe(fakeBody);
      expect(result.contentType).toBe("image/jpeg");
      expect(result.contentLength).toBe(12345);
    });

    it("throws when Body is missing", async () => {
      mockS3Send.mockResolvedValue({ Body: null });

      await expect(
        getAttachmentStream("attachments/inst/conv/missing.jpg"),
      ).rejects.toThrow("Attachment not found");
    });

    it("uses default content type when not provided", async () => {
      mockS3Send.mockResolvedValue({ Body: { pipe: vi.fn() } });

      const result = await getAttachmentStream("attachments/inst/conv/file.bin");

      expect(result.contentType).toBe("application/octet-stream");
    });
  });
});
