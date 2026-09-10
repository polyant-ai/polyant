// SPDX-License-Identifier: AGPL-3.0-or-later

import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import type { AttachmentMeta } from "../conversations/schema.js";
import { extensionFromMime } from "../utils/mime.js";
import { getAllSecrets } from "../instances/secrets.store.js";
import type { InstanceSlug } from "../instances/identifiers.js";
import {
  describeAgentS3Failure,
  resolveAgentS3,
  type AgentS3Config,
} from "./agent-s3.js";
import { attachmentsLog } from "./attachments-logger.js";

/**
 * Attachment persistence, on the AGENT's own bucket.
 *
 * It used to be the deployment's, through `PLATFORM_S3_BUCKET` and its three
 * companions: one bucket for every tenant, configured by an environment
 * variable nobody ever set — so no attachment was ever stored, on any
 * installation, and the panel's attachment view could not render.
 *
 * The bucket and its credentials are now the agent's secrets, the same ones the
 * `fileUpload` tool declares. What that buys, beyond the right tier: an agent
 * whose deployment runs on ECS needs no stored credentials at all, because
 * `s3_use_task_role` reaches the task role through the default provider chain.
 *
 * The bytes never gated the agent's own sight of the attachment: they reach the
 * model inline. This decides only whether the file can be reopened afterwards.
 */

/** Resolved per agent, cached: the client is stateless and the secrets are read per turn otherwise. */
const clients = new Map<string, AgentS3Config>();

/** Drop a cached client. Called when an agent's secrets change. */
export function invalidateAgentS3(instanceId: InstanceSlug): void {
  clients.delete(instanceId);
}

async function resolveFor(instanceId: InstanceSlug): Promise<AgentS3Config | null> {
  const cached = clients.get(instanceId);
  if (cached) return cached;

  const resolution = resolveAgentS3(await getAllSecrets(instanceId));
  if (!resolution.ok) {
    // A warn line rather than a throw: persistence is not the turn's purpose,
    // and there is no boot-time answer to give — an agent's storage is
    // configured (or not) per agent, long after boot.
    //
    // Through the module logger, not `console.warn`: the slug comes from a
    // request, and `createLogger` sanitizes both prefix and message, so a slug
    // carrying a newline cannot forge a log line.
    attachmentsLog.warn(
      "Storage",
      `${instanceId}: attachments will not be stored — ${describeAgentS3Failure(resolution)}`,
    );
    return null;
  }
  clients.set(instanceId, resolution.config);
  return resolution.config;
}

/** Whether this agent can store attachments at all. */
export async function isAgentStorageConfigured(instanceId: InstanceSlug): Promise<boolean> {
  return (await resolveFor(instanceId)) !== null;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Upload an attachment to the AGENT's bucket. Returns the metadata to store on
 * `conversation_messages.attachments`, or `null` when that agent has no
 * storage configured — which is the ordinary case and not an error.
 */
export async function uploadAttachment(
  data: Buffer,
  opts: {
    type: "image" | "file" | "audio" | "video";
    mimeType?: string;
    fileName?: string;
    instanceId: InstanceSlug;
    conversationId: string;
  },
): Promise<AttachmentMeta | null> {
  const resolved = await resolveFor(opts.instanceId);
  if (!resolved) return null;

  const ext = extensionFromMime(opts.mimeType);
  // Sanitize filename: strip path separators to prevent key injection
  const rawName = opts.fileName ?? `${randomUUID()}.${ext}`;
  const filename = rawName.replace(/[/\\]/g, "_");
  const s3Key = `attachments/${opts.instanceId}/${opts.conversationId}/${filename}`;

  await resolved.client.send(new PutObjectCommand({
    Bucket: resolved.bucket,
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
 * Fetch an attachment by its key, from the bucket of the agent the KEY names.
 *
 * The key is `attachments/{agentSlug}/{conversationId}/{filename}`, and the
 * caller has already been checked against that agent (`attachments.controller.ts`
 * asserts it before calling). Taking the agent from the key rather than from a
 * parameter is what keeps the two from disagreeing: the bucket read is the one
 * belonging to the agent whose ownership was verified.
 */
export async function getAttachmentStream(
  instanceId: InstanceSlug,
  s3Key: string,
): Promise<AttachmentStreamResult> {
  const resolved = await resolveFor(instanceId);
  if (!resolved) {
    throw new Error(`Agent "${instanceId}" has no attachment storage configured`);
  }

  const response = await resolved.client.send(new GetObjectCommand({
    Bucket: resolved.bucket,
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
