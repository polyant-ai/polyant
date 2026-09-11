// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Param, Res, NotFoundException } from "@nestjs/common";
import type { Response } from "express";
import { getAttachmentStream } from "../../attachments/agent-storage.js";
import { parseAttachmentKey } from "../../attachments/attachment-key.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { callerMayAccessAgent, type AgentAccessCaller } from "../../authz/agent-tenancy.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";

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
    // NOT a string: the wildcard arrives as an array of decoded segments. See
    // `parseAttachmentKey`, which owns both that shape and the key's format.
    @Param("key") rawKey: unknown,
    @Res() res: Response,
    @CurrentUser() caller?: AgentAccessCaller,
  ): Promise<void> {
    // No "is storage configured" pre-check any more: whether it is depends on
    // the AGENT, which is named by the key — and the key is not trustworthy until
    // the two checks below have passed. Storage that turns out to be absent
    // surfaces as the same 404 as a missing object, which is also the honest
    // answer: the caller may not learn from the status code whether an agent has
    // a bucket.

    // Security: reject path traversal and enforce the expected key structure.
    // A malformed key is the same 404 as every other refusal here.
    const parsed = parseAttachmentKey(rawKey);
    if (!parsed) throw notFound();
    const { key: s3Key, agentSlug, fileName } = parsed;

    // Cross-org IDOR gate (issue #133), BEFORE any S3 read. The route param is
    // named `key`, not `slug`, so PermissionGuard resolves no agent scope — it
    // authorizes the caller at its own org level and nothing ties the agent slug
    // embedded in the key to the caller's tenancy. `getAttachmentStream` is a raw
    // GetObject with no scoping either, so this is the only place to check.
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

      // Filename for Content-Disposition — parsed out of the key above.
      const disposition = contentType.startsWith("image/") ? "inline" : "attachment";
      res.setHeader("Content-Disposition", `${disposition}; filename="${fileName}"`);

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
