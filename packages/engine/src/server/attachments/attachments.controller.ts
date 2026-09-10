// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Param, Res, NotFoundException } from "@nestjs/common";
import type { Response } from "express";
import { getAttachmentStream } from "../../attachments/agent-storage.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
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
    // No "is storage configured" pre-check any more: whether it is depends on
    // the AGENT, which is named by the key — and the key is not trustworthy until
    // the two checks below have passed. Storage that turns out to be absent
    // surfaces as the same 404 as a missing object, which is also the honest
    // answer: the caller may not learn from the status code whether an agent has
    // a bucket.

    // Security: reject path traversal and enforce expected key structure
    if (s3Key.includes("..") || !KEY_PATTERN.test(s3Key)) {
      throw new NotFoundException("Invalid attachment key");
    }

    // Cross-org IDOR gate (issue #133), BEFORE any S3 read. The route param is
    // named `key`, not `slug`, so PermissionGuard resolves no agent scope — it
    // authorizes the caller at its own org level and nothing ties the agent slug
    // embedded in the key to the caller's tenancy. `getAttachmentStream` is a raw
    // GetObject with no scoping either, so this is the only place to check.
    const agentSlug = s3Key.split("/")[1];
    if (!(await callerMayAccessAgent(agentSlug, caller))) {
      throw notFound();
    }

    try {
      // The bucket is the one belonging to the agent the key names — the same
      // agent whose ownership was just verified. Taking it from the key rather
      // than from a second source is what keeps the check and the read from
      // disagreeing about which tenant's bytes these are.
      const { body, contentType, contentLength } = await getAttachmentStream(
        asInstanceSlug(agentSlug),
        s3Key,
      );

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
