// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Param, Res, NotFoundException, Inject } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";
import { getAttachmentStream, isPlatformStorageConfigured } from "../../attachments/platform-storage.js";
import { RequirePermission, Permission } from "../../authz/index.js";

/** Expected key format: attachments/{instanceId}/{conversationId}/{filename} */
const KEY_PATTERN = /^attachments\/[^/]+\/[^/]+\/[^/]+$/;

@Controller("api/attachments")
export class AttachmentsController {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  /**
   * Proxy endpoint for serving conversation attachments from platform S3.
   * The s3Key is the full path under the bucket: attachments/{instanceId}/{conversationId}/{filename}
   */
  @RequirePermission(Permission.CONVERSATION_READ)
  @Get("*key")
  async getAttachment(
    @Param("key") s3Key: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!isPlatformStorageConfigured()) {
      throw new NotFoundException("Attachment storage not configured");
    }

    // Security: reject path traversal and enforce expected key structure
    if (s3Key.includes("..") || !KEY_PATTERN.test(s3Key)) {
      throw new NotFoundException("Invalid attachment key");
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
