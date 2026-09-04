// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Param, Res, NotFoundException } from "@nestjs/common";
import type { Response } from "express";
import { getAttachmentStream, isPlatformStorageConfigured } from "../../attachments/platform-storage.js";
import { callerMayAccessAgent, type AgentAccessCaller } from "../../authz/agent-tenancy.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";

/** Expected key format: attachments/{agentSlug}/{conversationId}/{filename} */
const KEY_PATTERN = /^attachments\/[^/]+\/[^/]+\/[^/]+$/;

/** One 404 for every denial reason, so none of them is distinguishable. */
function notFound(): NotFoundException {
  return new NotFoundException("Attachment not found");
}

@Controller("api/attachments")
export class AttachmentsController {
  /**
   * Proxy endpoint for serving conversation attachments from platform S3.
   * The s3Key is the full path under the bucket: attachments/{agentSlug}/{conversationId}/{filename}
   */
  @RequirePermission(Permission.CONVERSATION_READ)
  @Get("*key")
  async getAttachment(
    @Param("key") s3Key: string,
    @Res() res: Response,
    @CurrentUser() caller?: AgentAccessCaller,
  ): Promise<void> {
    if (!isPlatformStorageConfigured()) {
      throw new NotFoundException("Attachment storage not configured");
    }

    // Security: reject path traversal and enforce expected key structure
    if (s3Key.includes("..") || !KEY_PATTERN.test(s3Key)) {
      throw new NotFoundException("Invalid attachment key");
    }

    // Cross-org IDOR gate (issue #133), BEFORE any S3 read. The route param is
    // named `key`, not `slug`, so PermissionGuard resolves no agent scope — it
    // authorizes the caller at its own org level and nothing ties the agent slug
    // embedded in the key to the caller's tenancy. `getAttachmentStream` is a raw
    // GetObject with no scoping either, so this is the only place to check.
    if (!(await callerMayAccessAgent(s3Key.split("/")[1], caller))) {
      throw notFound();
    }

    try {
      const { body, contentType, contentLength } = await getAttachmentStream(s3Key);

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      if (contentLength != null) {
        res.setHeader("Content-Length", contentLength);
      }

      // Extract filename for Content-Disposition
      const fileName = s3Key.split("/").pop();
      if (fileName) {
        const disposition = contentType.startsWith("image/") ? "inline" : "attachment";
        res.setHeader("Content-Disposition", `${disposition}; filename="${fileName}"`);
      }

      // Pipe the S3 stream to the HTTP response with error handling
      const nodeStream = body as NodeJS.ReadableStream;
      nodeStream.on("error", () => {
        if (!res.headersSent) {
          res.status(500).send("Stream error");
        } else {
          res.end();
        }
      });
      nodeStream.pipe(res);
    } catch {
      throw new NotFoundException("Attachment not found");
    }
  }

}
