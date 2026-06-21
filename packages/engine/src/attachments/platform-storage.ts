// SPDX-License-Identifier: AGPL-3.0-or-later

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { config } from "../config.js";
import type { AttachmentMeta } from "../conversations/schema.js";
import { extensionFromMime } from "../utils/mime.js";

// ---------------------------------------------------------------------------
// S3 client (lazily created, reused for all platform attachment operations)
// ---------------------------------------------------------------------------

let s3Client: S3Client | null = null;

function getS3Client(): S3Client | null {
  if (!config.platformS3) return null;
  if (!s3Client) {
    s3Client = new S3Client({
      region: config.platformS3.region,
      credentials: {
        accessKeyId: config.platformS3.accessKeyId,
        secretAccessKey: config.platformS3.secretAccessKey,
      },
    });
  }
  return s3Client;
}

/** Returns true when the platform S3 bucket is configured and attachments can be persisted. */
export function isPlatformStorageConfigured(): boolean {
  return config.platformS3 != null;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Upload an attachment buffer to the platform S3 bucket.
 * Returns metadata suitable for storing in `conversation_messages.attachments`.
 * Returns `null` if platform S3 is not configured.
 */
export async function uploadAttachment(
  data: Buffer,
  opts: {
    type: "image" | "file" | "audio" | "video";
    mimeType?: string;
    fileName?: string;
    agentId: string;
    conversationId: string;
  },
): Promise<AttachmentMeta | null> {
  const client = getS3Client();
  if (!client || !config.platformS3) return null;

  const ext = extensionFromMime(opts.mimeType);
  // Sanitize filename: strip path separators to prevent key injection
  const rawName = opts.fileName ?? `${randomUUID()}.${ext}`;
  const filename = rawName.replace(/[/\\]/g, "_");
  const s3Key = `attachments/${opts.agentId}/${opts.conversationId}/${filename}`;

  await client.send(new PutObjectCommand({
    Bucket: config.platformS3.bucket,
    Key: s3Key,
    Body: data,
    ContentType: opts.mimeType ?? "application/octet-stream",
  }));

  return {
    type: opts.type,
    mimeType: opts.mimeType,
    fileName: opts.fileName,
    s3Key,
    sizeBytes: data.length,
  };
}

// ---------------------------------------------------------------------------
// Download (for proxy API)
// ---------------------------------------------------------------------------

export interface AttachmentStreamResult {
  body: ReadableStream | NodeJS.ReadableStream;
  contentType: string;
  contentLength?: number;
}

/**
 * Fetch an attachment from platform S3 by its key.
 * Returns the readable stream + metadata for proxying to the browser.
 * Throws if the key is not found or S3 is not configured.
 */
export async function getAttachmentStream(s3Key: string): Promise<AttachmentStreamResult> {
  const client = getS3Client();
  if (!client || !config.platformS3) {
    throw new Error("Platform S3 not configured");
  }

  const response = await client.send(new GetObjectCommand({
    Bucket: config.platformS3.bucket,
    Key: s3Key,
  }));

  if (!response.Body) {
    throw new Error(`Attachment not found: ${s3Key}`);
  }

  return {
    body: response.Body as NodeJS.ReadableStream,
    contentType: response.ContentType ?? "application/octet-stream",
    contentLength: response.ContentLength,
  };
}
